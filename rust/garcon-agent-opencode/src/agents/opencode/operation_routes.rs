//! Ports `server-agents/opencode/src/agents/opencode/operation-routes.ts`.

use std::cell::{Cell, RefCell};
use std::error::Error;
use std::rc::Rc;

use garcon_contract::chat_modes::PermissionMode;
use garcon_interface::host::AgentLogger;
use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::prompt::GARCON_OPERATION_PART_METADATA_KEY;
use super::sse_events::SseEvent;
use super::turn_events::OpenCodeTurnContext;
use crate::js::{AbortSignal, SharedError, error, log_fields, prop, shared_error, strictly_equal};

#[derive(Debug)]
pub struct OpenCodeOperationRoute {
    pub session_id: String,
    pub chat_id: String,
    pub turn: OpenCodeTurnContext,
    pub supersedes_chat_source: bool,
    pub permission_mode: PermissionMode,
    pub directory: Option<String>,
    pub registration_ordinal: u64,
    pub request_abort_controller: AbortSignal,
}

/// An operation route, compared by identity as the original compares its route objects.
pub type Route = Rc<OpenCodeOperationRoute>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenCodeOperationEventSource {
    Operation { session_id: String },
    TaskChild { session_id: String },
}

impl OpenCodeOperationEventSource {
    pub fn session_id(&self) -> &str {
        match self {
            OpenCodeOperationEventSource::Operation { session_id }
            | OpenCodeOperationEventSource::TaskChild { session_id } => session_id,
        }
    }

    pub fn is_task_child(&self) -> bool {
        matches!(self, OpenCodeOperationEventSource::TaskChild { .. })
    }
}

#[derive(Debug)]
pub enum OpenCodeCompactionPartAdoption {
    Adopted { route: Route },
    RouteRetired,
    InvalidIdentifiers,
    IdentityCollision,
}

pub struct OpenCodeOperationRoutes {
    logger: Rc<dyn AgentLogger>,
    by_part: RefCell<IndexMap<String, Route>>,
    by_message: RefCell<IndexMap<String, Route>>,
    by_turn: RefCell<IndexMap<OpenCodeTurnContext, Route>>,
    by_task_child_session: RefCell<IndexMap<String, Route>>,
    latest_bound_ordinal_by_session: RefCell<IndexMap<String, u64>>,
    next_registration_ordinal: Cell<u64>,
}

impl OpenCodeOperationRoutes {
    pub fn new(logger: Rc<dyn AgentLogger>) -> Self {
        Self {
            logger,
            by_part: RefCell::default(),
            by_message: RefCell::default(),
            by_turn: RefCell::default(),
            by_task_child_session: RefCell::default(),
            latest_bound_ordinal_by_session: RefCell::default(),
            next_registration_ordinal: Cell::new(1),
        }
    }

    pub fn idle(&self) -> bool {
        self.by_turn.borrow().is_empty()
    }

    pub fn register(
        &self,
        session_id: &str,
        chat_id: &str,
        turn: OpenCodeTurnContext,
        supersedes_chat_source: bool,
        permission_mode: PermissionMode,
        directory: Option<String>,
    ) -> Result<Route, Box<dyn Error>> {
        if self.by_task_child_session.borrow().contains_key(session_id) {
            return Err(error(
                "Error",
                format!("OpenCode session {session_id} is already routed as a task child"),
            ));
        }
        let registration_ordinal = self.next_registration_ordinal.get();
        self.next_registration_ordinal.set(registration_ordinal + 1);
        let route = Rc::new(OpenCodeOperationRoute {
            session_id: session_id.to_owned(),
            chat_id: chat_id.to_owned(),
            turn: turn.clone(),
            supersedes_chat_source,
            permission_mode,
            directory,
            registration_ordinal,
            request_abort_controller: AbortSignal::new(),
        });
        let prompt_part_id = turn.borrow().provider_prompt_part_id.clone();
        let key = route_key(session_id, &prompt_part_id);
        if self.by_part.borrow().contains_key(&key) {
            return Err(error(
                "Error",
                format!("OpenCode prompt part {prompt_part_id} is already routed"),
            ));
        }
        self.by_part.borrow_mut().insert(key, route.clone());
        self.by_turn.borrow_mut().insert(turn, route.clone());
        Ok(route)
    }

    pub fn bind_part(&self, turn: &OpenCodeTurnContext, part_id: &str) -> bool {
        let Some(route) = self.by_turn.borrow().get(turn).cloned() else {
            return false;
        };
        let key = route_key(&route.session_id, part_id);
        let existing = self.by_part.borrow().get(&key).cloned();
        match existing {
            Some(existing) if Rc::ptr_eq(&existing, &route) => true,
            Some(_) => {
                self.logger.warn(
                    "Ignoring an OpenCode operation identity collision",
                    Some(&log_fields([
                        ("sessionId", Value::String(route.session_id.clone())),
                        ("partId", Value::String(part_id.to_owned())),
                    ])),
                );
                false
            }
            None => {
                self.by_part.borrow_mut().insert(key, route);
                true
            }
        }
    }

    pub fn unbind_part(&self, turn: &OpenCodeTurnContext, part_id: &str) {
        let Some(route) = self.by_turn.borrow().get(turn).cloned() else {
            return;
        };
        let key = route_key(&route.session_id, part_id);
        let bound_here = self
            .by_part
            .borrow()
            .get(&key)
            .is_some_and(|existing| Rc::ptr_eq(existing, &route));
        if bound_here {
            self.by_part.borrow_mut().shift_remove(&key);
        }
    }

    pub fn resolve_named(&self, session_id: &str, event: &SseEvent) -> Option<Route> {
        let properties = &event.properties;
        let part = prop(properties, "part");
        let info = prop(properties, "info");
        let tool = prop(properties, "tool");
        let ids = [
            prop(part, "id"),
            prop(part, "messageID"),
            prop(info, "parentID"),
            prop(info, "id"),
            prop(properties, "messageID"),
            prop(tool, "messageID"),
        ];
        for id in ids {
            let Some(id) = id.as_str().filter(|id| !id.is_empty()) else {
                continue;
            };
            let key = route_key(session_id, id);
            let by_part = self.by_part.borrow();
            let by_message = self.by_message.borrow();
            if let Some(route) = by_part.get(&key).or_else(|| by_message.get(&key)).cloned() {
                return Some(route);
            }
        }
        None
    }

    pub fn resolve(&self, session_id: &str, event: &SseEvent) -> Option<Route> {
        if let Some(named) = self.resolve_named(session_id, event) {
            return Some(named);
        }
        if event.kind != "message.part.updated" {
            return None;
        }
        let part = event.property("part");
        let part_id = prop(part, "id").as_str().unwrap_or_default();
        let message_id = prop(part, "messageID").as_str().unwrap_or_default();
        if part_id.is_empty() || message_id.is_empty() {
            return None;
        }
        let inherited_route =
            part.as_object()
                .and_then(part_operation_identity)
                .and_then(|inherited| {
                    self.by_part
                        .borrow()
                        .get(&route_key(session_id, &inherited))
                        .cloned()
                });
        let route = inherited_route?;
        if !self.bind_continuation(&route, part_id, message_id) {
            return None;
        }
        bind_continuation_identities(&route, message_id);
        Some(route)
    }

    pub fn adopt_compaction_part(
        &self,
        turn: &OpenCodeTurnContext,
        event: &SseEvent,
    ) -> OpenCodeCompactionPartAdoption {
        let Some(route) = self.by_turn.borrow().get(turn).cloned() else {
            return OpenCodeCompactionPartAdoption::RouteRetired;
        };
        let part = event.property("part");
        let part_id = prop(part, "id").as_str().unwrap_or_default();
        let message_id = prop(part, "messageID").as_str().unwrap_or_default();
        if part_id.is_empty() || message_id.is_empty() {
            return OpenCodeCompactionPartAdoption::InvalidIdentifiers;
        }
        if !self.try_bind_continuation(&route, part_id, message_id) {
            return OpenCodeCompactionPartAdoption::IdentityCollision;
        }
        bind_continuation_identities(&route, message_id);
        OpenCodeCompactionPartAdoption::Adopted { route }
    }

    pub fn bind_task_child_session(&self, route: &Route, event: &SseEvent) -> bool {
        if !self.is_registered(route) {
            return false;
        }
        let Some(child_session_id) = task_child_session_id(event) else {
            return false;
        };
        if child_session_id == route.session_id {
            return false;
        }
        self.bind_task_child(route, &child_session_id)
    }

    // Affiliates nested tasks only through a parent already bound by task-part metadata.
    // https://github.com/anomalyco/opencode/blob/2b72179c663cadcb54f54d9f19221b3fb3d11fb6/packages/opencode/src/tool/task.ts#L158-L195
    pub fn bind_task_descendant_session(&self, event: &SseEvent) -> Option<Route> {
        let created = task_child_creation(event)?;
        let route = self.resolve_task_child(&created.parent_session_id)?;
        self.bind_task_child(&route, &created.child_session_id)
            .then_some(route)
    }

    pub fn resolve_task_child(&self, session_id: &str) -> Option<Route> {
        let route = self
            .by_task_child_session
            .borrow()
            .get(session_id)
            .cloned()?;
        self.is_registered(&route).then_some(route)
    }

    pub fn observe(&self, route: &Route, event: &SseEvent) {
        let part = event.property("part");
        let prompt_part_id = route.turn.borrow().provider_prompt_part_id.clone();
        if prop(part, "id").as_str() == Some(prompt_part_id.as_str()) {
            let provider_message_id = prop(part, "messageID").as_str().unwrap_or_default();
            if provider_message_id.is_empty() {
                return;
            }
            self.activate_source(route, provider_message_id);
        }

        let info = event.property("info");
        if prop(info, "role").as_str() == Some("assistant")
            && let Some(info_id) = prop(info, "id").as_str().filter(|id| !id.is_empty())
        {
            self.bind_message(route, info_id);
        }
        if let Some(message_id) = prop(part, "messageID").as_str().filter(|id| !id.is_empty()) {
            self.bind_message(route, message_id);
        }
    }

    pub fn unregister(&self, route: &Route) {
        self.retire_route(route);
    }

    pub fn retire_turn(&self, turn: &OpenCodeTurnContext) {
        let route = self.by_turn.borrow().get(turn).cloned();
        if let Some(route) = route {
            self.retire_route(&route);
        }
    }

    pub fn retire_session(&self, chat_id: &str, session_id: &str) {
        let routes: Vec<Route> = self
            .by_turn
            .borrow()
            .values()
            .filter(|route| route.chat_id == chat_id && route.session_id == session_id)
            .cloned()
            .collect();
        for route in routes {
            self.retire_route(&route);
        }
    }

    pub fn cancel_request(&self, turn: &OpenCodeTurnContext, reason: SharedError) {
        let route = self.by_turn.borrow().get(turn).cloned();
        if let Some(route) = route {
            route.request_abort_controller.abort(reason);
        }
    }

    pub fn is_registered(&self, route: &Route) -> bool {
        self.by_turn
            .borrow()
            .get(&route.turn)
            .is_some_and(|registered| Rc::ptr_eq(registered, route))
    }

    pub fn activate_from_response(&self, route: &Route, provider_message_id: &str) -> bool {
        if !self.is_registered(route) {
            return false;
        }
        self.activate_source(route, provider_message_id);
        true
    }

    pub fn clear(&self) {
        let routes: Vec<Route> = self.by_turn.borrow().values().cloned().collect();
        for route in routes {
            route.request_abort_controller.abort(shared_error(
                "Error",
                "OpenCode provider event source retired",
            ));
        }
        self.by_part.borrow_mut().clear();
        self.by_message.borrow_mut().clear();
        self.by_turn.borrow_mut().clear();
        self.by_task_child_session.borrow_mut().clear();
        self.latest_bound_ordinal_by_session.borrow_mut().clear();
    }

    fn activate_source(&self, route: &Route, provider_message_id: &str) {
        self.bind_message(route, provider_message_id);
        let latest_bound_ordinal = self
            .latest_bound_ordinal_by_session
            .borrow()
            .get(&route.session_id)
            .copied()
            .unwrap_or(0);
        if latest_bound_ordinal > route.registration_ordinal {
            return;
        }
        if route.supersedes_chat_source {
            // Retiring changes the map, so the routes are visited from a snapshot.
            let superseded: Vec<Route> = self
                .by_part
                .borrow()
                .values()
                .filter(|existing| {
                    existing.chat_id == route.chat_id
                        && existing.registration_ordinal < route.registration_ordinal
                })
                .cloned()
                .collect();
            for existing in superseded {
                self.retire_route(&existing);
            }
        }
        self.latest_bound_ordinal_by_session
            .borrow_mut()
            .insert(route.session_id.clone(), route.registration_ordinal);
    }

    fn bind_continuation(&self, route: &Route, part_id: &str, message_id: &str) -> bool {
        if self.try_bind_continuation(route, part_id, message_id) {
            return true;
        }
        self.logger.warn(
            "Ignoring an OpenCode operation identity collision",
            Some(&log_fields([
                ("sessionId", Value::String(route.session_id.clone())),
                ("partId", Value::String(part_id.to_owned())),
                ("messageId", Value::String(message_id.to_owned())),
            ])),
        );
        false
    }

    fn try_bind_continuation(&self, route: &Route, part_id: &str, message_id: &str) -> bool {
        let part_key = route_key(&route.session_id, part_id);
        let message_key = route_key(&route.session_id, message_id);
        {
            let by_part = self.by_part.borrow();
            let by_message = self.by_message.borrow();
            let taken_by_another = by_part
                .get(&part_key)
                .is_some_and(|other| !Rc::ptr_eq(other, route))
                || by_message
                    .get(&message_key)
                    .is_some_and(|other| !Rc::ptr_eq(other, route));
            if taken_by_another {
                return false;
            }
        }
        self.by_part.borrow_mut().insert(part_key, route.clone());
        self.by_message
            .borrow_mut()
            .insert(message_key, route.clone());
        true
    }

    fn bind_message(&self, route: &Route, message_id: &str) {
        let key = route_key(&route.session_id, message_id);
        let existing = self.by_message.borrow().get(&key).cloned();
        match existing {
            Some(existing) if Rc::ptr_eq(&existing, route) => {}
            Some(_) => self.logger.warn(
                "Ignoring an OpenCode operation identity collision",
                Some(&log_fields([
                    ("sessionId", Value::String(route.session_id.clone())),
                    ("messageId", Value::String(message_id.to_owned())),
                ])),
            ),
            None => {
                self.by_message.borrow_mut().insert(key, route.clone());
            }
        }
    }

    fn bind_task_child(&self, route: &Route, child_session_id: &str) -> bool {
        let existing_child_route = self
            .by_task_child_session
            .borrow()
            .get(child_session_id)
            .cloned();
        let existing_session_route = self
            .by_turn
            .borrow()
            .values()
            .find(|candidate| candidate.session_id == child_session_id)
            .cloned();
        let taken_by_another = |existing: &Option<Route>| {
            existing
                .as_ref()
                .is_some_and(|existing| !Rc::ptr_eq(existing, route))
        };
        if taken_by_another(&existing_child_route) || taken_by_another(&existing_session_route) {
            self.logger.warn(
                "Ignoring an OpenCode task child session identity collision",
                Some(&log_fields([
                    ("parentSessionId", Value::String(route.session_id.clone())),
                    ("childSessionId", Value::String(child_session_id.to_owned())),
                ])),
            );
            return false;
        }
        self.by_task_child_session
            .borrow_mut()
            .insert(child_session_id.to_owned(), route.clone());
        true
    }

    fn retire_route(&self, route: &Route) {
        route
            .request_abort_controller
            .abort(shared_error("Error", "OpenCode operation route retired"));
        self.by_part
            .borrow_mut()
            .retain(|_, candidate| !Rc::ptr_eq(candidate, route));
        self.by_message
            .borrow_mut()
            .retain(|_, candidate| !Rc::ptr_eq(candidate, route));
        self.by_task_child_session
            .borrow_mut()
            .retain(|_, candidate| !Rc::ptr_eq(candidate, route));
        self.by_turn.borrow_mut().shift_remove(&route.turn);
        let session_still_routed = self
            .by_turn
            .borrow()
            .values()
            .any(|candidate| candidate.session_id == route.session_id);
        if !session_still_routed {
            self.latest_bound_ordinal_by_session
                .borrow_mut()
                .shift_remove(&route.session_id);
        }
    }
}

// A provider continuation the turn adopted: its message is bookkeeping the
// turn has seen and may extend from.
fn bind_continuation_identities(route: &Route, message_id: &str) {
    let mut turn = route.turn.borrow_mut();
    turn.observed_user_message_ids.insert(message_id.to_owned());
    turn.provider_continuation_message_ids
        .insert(message_id.to_owned());
}

fn task_child_session_id(event: &SseEvent) -> Option<String> {
    if event.kind != "message.part.updated" {
        return None;
    }
    let part = event.property("part");
    if prop(part, "type").as_str() != Some("tool") || prop(part, "tool").as_str() != Some("task") {
        return None;
    }
    let metadata = prop(prop(part, "state"), "metadata");
    if !metadata.is_object() {
        return None;
    }
    prop(metadata, "sessionId")
        .as_str()
        .filter(|session_id| !session_id.is_empty())
        .map(str::to_owned)
}

struct TaskChildCreation {
    child_session_id: String,
    parent_session_id: String,
}

fn task_child_creation(event: &SseEvent) -> Option<TaskChildCreation> {
    if event.kind != "session.created" {
        return None;
    }
    let properties = &event.properties;
    let session_id = prop(properties, "sessionID");
    let info = prop(properties, "info");
    if !info.is_object() {
        return None;
    }
    let child_session_id = prop(info, "id");
    let parent_session_id = prop(info, "parentID");
    let session_id = session_id.as_str().filter(|id| !id.is_empty())?;
    let parent_session_id = parent_session_id
        .as_str()
        .filter(|parent| !parent.is_empty())?;
    // The child's ID is read as the event's own session ID, which is a string.
    let same = strictly_equal(child_session_id, &Value::String(session_id.to_owned()));
    (same && parent_session_id != session_id).then(|| TaskChildCreation {
        child_session_id: session_id.to_owned(),
        parent_session_id: parent_session_id.to_owned(),
    })
}

fn part_operation_identity(part: &Map<String, Value>) -> Option<String> {
    let metadata = prop(part, "metadata");
    if !metadata.is_object() {
        return None;
    }
    prop(metadata, GARCON_OPERATION_PART_METADATA_KEY)
        .as_str()
        .filter(|operation_part_id| !operation_part_id.is_empty())
        .map(str::to_owned)
}

fn route_key(session_id: &str, provider_id: &str) -> String {
    format!("{session_id}\0{provider_id}")
}
