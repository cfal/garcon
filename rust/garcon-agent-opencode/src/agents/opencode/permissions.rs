//! Ports `server-agents/opencode/src/agents/opencode/permissions.ts`.

use std::{cell::RefCell, rc::Rc};

use futures::FutureExt;
use garcon_contract::{
    chat_command_contracts::PermissionDecisionPayload, chat_modes::PermissionMode,
};
use garcon_interface::resources::ExecutorResult;
use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use super::{
    operation_routes::{OpenCodeOperationEventSource, Route},
    permission_tool_converter::convert_opencode_permission_tool,
    questions::{
        OpenCodeAutomaticDecision, OpenCodeQuestionController, OpenCodeQuestionControllerOptions,
        PendingOpenCodeDecision,
    },
    sdk_client::{OpenCodeClient, OpenCodeRequest},
    sdk_result::throw_open_code_result_error,
    sse_events::SseEvent,
};
use crate::js::{error, log_fields, own, prop, string_of, truthy};

// Source of OpenCode permission keys:
// - https://github.com/anomalyco/opencode/blob/f5eade1d2b95562c7fb58e3041e662a8b2b611b6/packages/web/src/content/docs/permissions.mdx
// - https://github.com/anomalyco/opencode/blob/f5eade1d2b95562c7fb58e3041e662a8b2b611b6/packages/opencode/src/agent/agent.ts
pub const OPENCODE_PERMISSION_KEYS: &[&str] = &[
    "read",
    "edit",
    "glob",
    "grep",
    "list",
    "bash",
    "task",
    "skill",
    "lsp",
    "todoread",
    "todowrite",
    "webfetch",
    "websearch",
    "codesearch",
    "external_directory",
    "doom_loop",
    "question",
    "plan_enter",
    "plan_exit",
];

const OPENCODE_NATIVE_PLAN_PERMISSIONS: &[&str] = &["plan_enter", "plan_exit"];

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PermissionRule {
    pub permission: &'static str,
    pub pattern: &'static str,
    pub action: &'static str,
}

// Native plan transitions create unmarked synthetic continuations that cannot be safely
// affiliated with an operation, so bypass mode keeps them unavailable. The original reads
// its mode table with the caller's key, so a key such as "constructor" finds an inherited
// member and yields no rules; here every other mode takes the path of the default.
pub fn map_permission_mode(mode: &str) -> Vec<PermissionRule> {
    let rule = |permission: &'static str, action: &'static str| PermissionRule {
        permission,
        pattern: "*",
        action,
    };
    match mode {
        "acceptEdits" => vec![
            rule("edit", "allow"),
            rule("bash", "ask"),
            rule("webfetch", "allow"),
        ],
        "bypassPermissions" => OPENCODE_PERMISSION_KEYS
            .iter()
            .map(|permission| {
                rule(
                    permission,
                    if OPENCODE_NATIVE_PLAN_PERMISSIONS.contains(permission) {
                        "deny"
                    } else {
                        "allow"
                    },
                )
            })
            .collect(),
        _ => vec![
            rule("edit", "ask"),
            rule("bash", "ask"),
            rule("webfetch", "ask"),
        ],
    }
}

/// `allow ? (alwaysAllow ? "always" : "once") : "reject"` over the two flags
/// as the original reads them, by truthiness.
pub fn map_permission_decision(decision: Option<&Value>) -> &'static str {
    let allow = decision.is_some_and(|decision| truthy(prop(decision, "allow")));
    let always_allow = decision.is_some_and(|decision| truthy(prop(decision, "alwaysAllow")));
    permission_reply(allow, always_allow)
}

fn permission_reply(allow: bool, always_allow: bool) -> &'static str {
    match (allow, always_allow) {
        (true, true) => "always",
        (true, false) => "once",
        (false, _) => "reject",
    }
}

pub type OpenCodeDecisionControllerOptions = OpenCodeQuestionControllerOptions;

pub struct OpenCodeDecisionController {
    options: Rc<OpenCodeDecisionControllerOptions>,
    pending: RefCell<IndexMap<String, Rc<PendingOpenCodeDecision>>>,
    questions: Rc<OpenCodeQuestionController>,
}

impl OpenCodeDecisionController {
    pub fn new(options: OpenCodeDecisionControllerOptions) -> Rc<Self> {
        let options = Rc::new(options);
        Rc::new(Self {
            questions: OpenCodeQuestionController::new(options.clone()),
            options,
            pending: RefCell::default(),
        })
    }

    pub fn idle(&self) -> bool {
        self.pending.borrow().is_empty() && self.questions.idle()
    }

    pub fn handle(
        self: &Rc<Self>,
        client: Rc<dyn OpenCodeClient>,
        event: &SseEvent,
        source: &OpenCodeOperationEventSource,
        route: &Route,
    ) -> bool {
        if event.kind == "question.asked" {
            self.questions.handle(client, event, source, route);
            return true;
        }
        if event.kind != "permission.asked" {
            return false;
        }
        let message_id = prop(event.property("tool"), "messageID").as_str();
        if !source.is_task_child()
            && let Some(message_id) =
                message_id.filter(|id| !route.turn.borrow().assistant_message_ids.contains(*id))
        {
            self.options.logger.warn(
                "Ignoring an OpenCode permission for a message outside its turn",
                Some(&log_fields([
                    ("agentSessionId", json!(route.session_id)),
                    ("eventId", json!(event.id)),
                    ("toolMessageId", json!(message_id)),
                ])),
            );
            return true;
        }
        let Some(permission) = extract_permission_request(event) else {
            return true;
        };
        if route.permission_mode == PermissionMode::ManualBypass {
            self.options.run_automatic_decision(
                client,
                route,
                permission.request_id,
                OpenCodeAutomaticDecision::ManualBypass,
            );
            return true;
        }
        let id = (self.options.new_id)();
        let pending = Rc::new(PendingOpenCodeDecision::new(
            route,
            id.clone(),
            permission.request_id,
        ));
        self.pending
            .borrow_mut()
            .insert(id.clone(), pending.clone());
        let tool = convert_opencode_permission_tool(
            &self.options.timestamp(),
            &id,
            &Value::Object(permission.tool_input),
        );
        let controller = Rc::downgrade(self);
        self.options.publish_request(
            &pending,
            tool,
            Rc::new({
                let pending = pending.clone();
                move |decision| {
                    let controller = controller.upgrade();
                    let pending = pending.clone();
                    async move {
                        let controller = controller.ok_or_else(|| {
                            error(
                                "Error",
                                "OpenCode permission occurrence is no longer pending",
                            )
                        })?;
                        controller.resolve(pending, decision).await
                    }
                    .boxed_local()
                }
            }),
        );
        true
    }

    pub fn cancel_for_session(&self, agent_session_id: &str, reason: &str) {
        let matching: Vec<_> = self
            .pending
            .borrow()
            .values()
            .filter(|pending| pending.session_id == agent_session_id)
            .cloned()
            .collect();
        for pending in matching {
            self.pending
                .borrow_mut()
                .shift_remove(&pending.occurrence_id);
            self.options.publish_cancellation(&pending, reason);
        }
        self.questions.cancel_for_session(agent_session_id, reason);
    }

    pub fn clear(&self) {
        self.pending.borrow_mut().clear();
        self.questions.clear();
    }

    async fn resolve(
        &self,
        pending: Rc<PendingOpenCodeDecision>,
        decision: PermissionDecisionPayload,
    ) -> ExecutorResult<()> {
        if !self
            .pending
            .borrow()
            .get(&pending.occurrence_id)
            .is_some_and(|current| Rc::ptr_eq(&pending, current))
        {
            return Err(error(
                "Error",
                "OpenCode permission occurrence is no longer pending",
            ));
        }
        let reply = permission_reply(decision.allow, decision.always_allow == Some(true));
        let client = (self.options.get_client)().await?;
        let mut body = Map::from_iter([
            (
                "requestID".to_owned(),
                Value::from(pending.original_request_id.clone()),
            ),
            ("reply".to_owned(), Value::from(reply)),
        ]);
        if !decision.allow {
            body.insert("message".to_owned(), Value::from("User denied tool use"));
        }
        let result = self
            .options
            .run_request(
                client,
                "OpenCode permission reply",
                OpenCodeRequest::PermissionReply,
                body,
                &pending.scope,
            )
            .await?;
        throw_open_code_result_error(&result, "OpenCode permission reply failed")?;
        self.pending
            .borrow_mut()
            .shift_remove(&pending.occurrence_id);
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodePermissionRequest {
    pub request_id: String,
    pub tool_input: Map<String, Value>,
}

#[cfg(test)]
mod tests;

pub fn extract_permission_request(event: &SseEvent) -> Option<OpenCodePermissionRequest> {
    if event.kind != "permission.asked" {
        return None;
    }
    let props = &event.properties;
    let request_id = [prop(props, "requestID"), prop(props, "id")]
        .into_iter()
        .find(|value| truthy(value))?;
    let or_value = |key: &str| own(props, key).filter(|value| truthy(value)).cloned();
    let or_null = |key: &str| or_value(key).unwrap_or(Value::Null);
    let or_empty_object = |key: &str| or_value(key).unwrap_or_else(|| Value::Object(Map::new()));
    let array_or_empty = |key: &str| prop(props, key).as_array().cloned().unwrap_or_default();
    Some(OpenCodePermissionRequest {
        request_id: string_of(Some(request_id)).into_owned(),
        tool_input: Map::from_iter([
            ("permission".to_owned(), or_null("permission")),
            (
                "patterns".to_owned(),
                Value::Array(array_or_empty("patterns")),
            ),
            ("metadata".to_owned(), or_empty_object("metadata")),
            ("always".to_owned(), Value::Array(array_or_empty("always"))),
            ("tool".to_owned(), or_null("tool")),
        ]),
    })
}
