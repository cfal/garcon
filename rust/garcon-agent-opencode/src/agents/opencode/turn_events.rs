//! Ports `server-agents/opencode/src/agents/opencode/turn-events.ts`.

use std::cmp::Ordering;
use std::fmt;

use garcon_agents_common::execution::runtime_events::{AgentRuntimeEvent, AgentRuntimeOperation};
use garcon_contract::chat_modes::PermissionMode;
use garcon_interface::host::AgentLogger;
use garcon_js::utf16;
use indexmap::{IndexMap, IndexSet};
use serde_json::Value;

use super::prompt_response::TurnFinalResponse;
use super::sse_events::{OpenCodeAssistantTerminal, SseEvent, is_compaction_assistant};
use crate::js::{Shared, log_fields, prop, strictly_equal};

pub struct TurnContextData {
    pub operation: AgentRuntimeOperation,
    pub final_response: Option<TurnFinalResponse>,
    // A manual compaction turn: the provider's summary assistant settles the turn
    // and its internals stay out of the transcript.
    pub compaction: bool,
    // Later message updates retain the completed timestamp, so a manual turn
    // would otherwise republish its boundary.
    pub manual_compaction_boundary_published: bool,
    // OpenCode assigns this ID and Garcon resolves it from the submitted prompt part event.
    pub provider_message_id: Option<String>,
    pub provider_prompt_part_id: String,
    pub provider_prompt_request_completed: bool,
    pub provider_steering_delivery_unconfirmed: bool,
    // Identity of the last surfaced retry notice so stream replays and repeated
    // status frames for the same scheduled attempt append one row, not many.
    pub last_retry_notice_key: Option<String>,
    pub provider_continuation_message_ids: IndexSet<String>,
    // Tracks automatic control messages and linked summary assistants so prompt
    // failures exclude internal compaction work.
    pub automatic_compaction_message_ids: IndexSet<String>,
    pub recent_event_ids: IndexSet<String>,
    pub provider_steering_part_ids: IndexSet<String>,
    pub pending_steering_message_ids: IndexSet<String>,
    pub observed_user_message_ids: IndexSet<String>,
    pub assistant_message_ids: IndexSet<String>,
    pub assistant_terminals: IndexMap<String, OpenCodeAssistantTerminal>,
    pub published_part_ids: IndexSet<String>,
    pub message_roles: IndexMap<String, String>,
    pub assistant_part_types: IndexMap<String, String>,
}

impl fmt::Debug for TurnContextData {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenCodeTurnContext")
            .field("run_id", &self.operation.run_id)
            .field("provider_prompt_part_id", &self.provider_prompt_part_id)
            .field("provider_message_id", &self.provider_message_id)
            .finish_non_exhaustive()
    }
}

/// The context of one turn, shared by its session, its routes, and steering.
pub type OpenCodeTurnContext = Shared<TurnContextData>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    Running,
    Completed,
    Aborted,
}

#[derive(Debug, PartialEq)]
pub struct SessionData {
    pub status: SessionStatus,
    // Set while a provider abort is in flight so a named completion cannot claim the turn
    // before the abort is acknowledged; a rejected abort replays the completion.
    pub aborting: Option<bool>,
    pub chat_id: String,
    pub model: Option<String>,
    // The variant the current turn submitted, so steering joins the same effort.
    pub thinking_variant: Option<String>,
    pub permission_mode: PermissionMode,
    pub directory: Option<String>,
    pub started_at: String,
    pub last_activity_at: f64,
    // Turn-derived uncertainty requires an abort before reuse. Stream loss pins it until process
    // closure; abort start sets it eagerly, while steering release and settlement may recompute it.
    // Pending reverts remain purge-fenced.
    pub provider_work_requires_quiescence: bool,
    pub active_steering_deliveries: usize,
    pub deferred_terminal: Option<OpenCodeAssistantTerminal>,
    // A stopped turn leaves accepted follow-up messages in OpenCode's transcript. The next
    // prompt reverts the earliest unconsumed one before OpenCode can include it in model input.
    pub pending_steering_revert_message_id: Option<String>,
    pub turn: OpenCodeTurnContext,
}

/// The runtime's record of one provider session, shared by every holder.
pub type OpenCodeSession = Shared<SessionData>;

pub struct ActivateTurnInput {
    pub chat_id: String,
    pub model: Option<String>,
    pub thinking_variant: Option<String>,
    pub permission_mode: PermissionMode,
    pub directory: Option<String>,
    pub turn: OpenCodeTurnContext,
}

pub fn relocate_open_code_session(session: &OpenCodeSession, directory: &str, now_ms: f64) {
    let mut session = session.borrow_mut();
    session.directory = Some(directory.to_owned());
    session.last_activity_at = now_ms;
}

pub fn activate_open_code_session_turn(
    session: &OpenCodeSession,
    input: ActivateTurnInput,
    now_ms: f64,
) {
    let mut session = session.borrow_mut();
    session.status = SessionStatus::Running;
    session.aborting = Some(false);
    session.provider_work_requires_quiescence = false;
    session.active_steering_deliveries = 0;
    session.deferred_terminal = None;
    session.chat_id = input.chat_id;
    session.model = input.model;
    session.thinking_variant = input.thinking_variant;
    session.permission_mode = input.permission_mode;
    session.directory = input.directory;
    session.last_activity_at = now_ms;
    session.turn = input.turn;
}

// OpenCode assigns IDs before durable commits, so concurrent publishers can deliver unseen
// events outside lexical order. The bounded window rejects actual duplicates without making
// ordering an arrival contract; durable sequence metadata can replace it if global replay grows.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/core/src/event.ts#L419-L437
const RECENT_EVENT_ID_LIMIT: usize = 512;

pub fn create_open_code_turn_context(
    operation: AgentRuntimeOperation,
    compaction: bool,
    new_id: &dyn Fn() -> String,
) -> OpenCodeTurnContext {
    OpenCodeTurnContext::new(TurnContextData {
        operation,
        compaction,
        final_response: None,
        manual_compaction_boundary_published: false,
        provider_message_id: None,
        provider_prompt_part_id: create_open_code_prompt_part_id(new_id),
        provider_prompt_request_completed: false,
        provider_steering_delivery_unconfirmed: false,
        last_retry_notice_key: None,
        provider_continuation_message_ids: IndexSet::new(),
        automatic_compaction_message_ids: IndexSet::new(),
        recent_event_ids: IndexSet::new(),
        provider_steering_part_ids: IndexSet::new(),
        pending_steering_message_ids: IndexSet::new(),
        observed_user_message_ids: IndexSet::new(),
        assistant_message_ids: IndexSet::new(),
        assistant_terminals: IndexMap::new(),
        published_part_ids: IndexSet::new(),
        message_roles: IndexMap::new(),
        assistant_part_types: IndexMap::new(),
    })
}

pub fn open_code_turn_requires_provider_quiescence(turn: &OpenCodeTurnContext) -> bool {
    let turn = turn.borrow();
    !turn.provider_prompt_request_completed
        || turn.provider_steering_delivery_unconfirmed
        || !turn.pending_steering_message_ids.is_empty()
}

/// `prt_` and a UUID without its hyphens.
pub fn create_open_code_prompt_part_id(new_id: &dyn Fn() -> String) -> String {
    format!("prt_{}", new_id().replace('-', ""))
}

pub fn observe_open_code_steering_part(
    session: &OpenCodeSession,
    event: &SseEvent,
) -> Option<String> {
    if event.kind != "message.part.updated" {
        return None;
    }
    let part = event.property("part");
    let part_id = prop(part, "id").as_str().unwrap_or_default();
    let message_id = prop(part, "messageID").as_str().unwrap_or_default();
    if part_id.is_empty() || message_id.is_empty() {
        return None;
    }
    let session = session.borrow();
    if !session
        .turn
        .borrow()
        .provider_steering_part_ids
        .contains(part_id)
    {
        return None;
    }
    let mut turn = session.turn.borrow_mut();
    turn.provider_continuation_message_ids
        .insert(message_id.to_owned());
    turn.pending_steering_message_ids
        .insert(message_id.to_owned());
    Some(part_id.to_owned())
}

pub fn accept_unique_open_code_turn_event(
    turn: &OpenCodeTurnContext,
    event: &SseEvent,
    logger: &dyn AgentLogger,
) -> bool {
    if !matches!(
        event.kind.as_str(),
        "message.updated"
            | "message.part.updated"
            | "message.part.delta"
            | "permission.asked"
            | "question.asked"
            | "session.status"
            | "session.error"
            | "session.compacted"
    ) {
        return true;
    }
    let Some(event_id) = event.id.as_deref().filter(|id| !id.is_empty()) else {
        logger.warn(
            "Ignoring OpenCode event without an event ID",
            Some(&log_fields([(
                "eventType",
                Value::String(event.kind.clone()),
            )])),
        );
        return false;
    };
    let replayed = {
        let mut turn = turn.borrow_mut();
        if turn.recent_event_ids.insert(event_id.to_owned()) {
            // The oldest ID is the first one inserted.
            if turn.recent_event_ids.len() > RECENT_EVENT_ID_LIMIT {
                turn.recent_event_ids.shift_remove_index(0);
            }
            false
        } else {
            true
        }
    };
    if replayed {
        logger.debug(
            "Ignoring replayed OpenCode event",
            Some(&log_fields([
                ("eventType", Value::String(event.kind.clone())),
                ("eventId", Value::String(event_id.to_owned())),
            ])),
        );
    }
    !replayed
}

pub fn open_code_event_belongs_to_turn(turn: &OpenCodeTurnContext, event: &SseEvent) -> bool {
    let properties = &event.properties;
    match event.kind.as_str() {
        "message.updated" => {
            let info = prop(properties, "info");
            let message_id = prop(info, "id").as_str().unwrap_or_default();
            if prop(info, "role").as_str() == Some("user") {
                if !message_id.is_empty() {
                    turn.borrow_mut()
                        .observed_user_message_ids
                        .insert(message_id.to_owned());
                }
                return false;
            }
            let (has_source, parent_is_source, parent_continues) = {
                let turn = turn.borrow();
                let parent = prop(info, "parentID");
                (
                    turn.provider_message_id.is_some(),
                    turn.provider_message_id.as_deref() == parent.as_str(),
                    parent.as_str().is_some_and(|parent| {
                        turn.provider_continuation_message_ids.contains(parent)
                    }),
                )
            };
            if prop(info, "role").as_str() != Some("assistant")
                || !has_source
                || !parent_is_source && !parent_continues
                || message_id.is_empty()
            {
                return false;
            }
            // The parent matched the source or a continuation, so it is a string here.
            let parent_id = prop(info, "parentID").as_str().unwrap_or_default();
            let mut turn = turn.borrow_mut();
            if info.as_object().is_some_and(is_compaction_assistant) {
                if !turn.compaction {
                    if !turn.automatic_compaction_message_ids.contains(parent_id) {
                        return false;
                    }
                    // A recorded terminal means this automatic boundary already dispatched;
                    // terminal recording follows dispatch in the global event handler.
                    if turn.assistant_terminals.contains_key(message_id) {
                        return false;
                    }
                    turn.automatic_compaction_message_ids
                        .insert(message_id.to_owned());
                }
                turn.assistant_message_ids.insert(message_id.to_owned());
                return true;
            }
            turn.assistant_message_ids.insert(message_id.to_owned());
            // A batched loop consumes every queued steering message up to its parent;
            // ids sort lexically, so all pending steers at or below the parent were read.
            turn.pending_steering_message_ids
                .retain(|pending| utf16::cmp(pending, parent_id) == Ordering::Greater);
            true
        }
        "message.part.updated" => {
            let part = prop(properties, "part");
            let message_id = prop(part, "messageID").as_str().unwrap_or_default();
            let prompt_part_id = turn.borrow().provider_prompt_part_id.clone();
            if turn.borrow().provider_message_id.is_none() {
                // OpenCode preserves caller-owned part IDs while assigning the ordered message ID.
                // https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/session/prompt.ts#L693-L697
                if message_id.is_empty()
                    || !strictly_equal(prop(part, "id"), &Value::String(prompt_part_id))
                {
                    return false;
                }
                turn.borrow_mut().provider_message_id = Some(message_id.to_owned());
                let (compaction, publish) = {
                    let turn = turn.borrow();
                    (turn.compaction, turn.operation.publish.clone())
                };
                // Steering joins the loop that answers this message, so the turn can take it from now on.
                if !compaction {
                    publish(AgentRuntimeEvent::Steerable);
                }
                return false;
            }
            let turn = turn.borrow();
            if !message_id.is_empty() && turn.observed_user_message_ids.contains(message_id) {
                return false;
            }
            !message_id.is_empty() && turn.assistant_message_ids.contains(message_id)
        }
        "message.part.delta" => prop(properties, "messageID")
            .as_str()
            .is_some_and(|message_id| turn.borrow().assistant_message_ids.contains(message_id)),
        _ => true,
    }
}

pub fn should_warn_for_unrouted_open_code_event(event_type: &str, managed_session: bool) -> bool {
    // Native fork replays are published before OpenCode returns the child session identity.
    // https://github.com/anomalyco/opencode/blob/47b6b6f5f4f9b42d2bce7af1c4e5bf6efaf22ba7/packages/opencode/src/session/session.ts#L691-L730
    if !managed_session && matches!(event_type, "message.updated" | "message.part.updated") {
        return false;
    }
    matches!(
        event_type,
        "message.updated"
            | "message.part.updated"
            | "message.part.delta"
            | "permission.asked"
            | "question.asked"
            | "session.error"
    )
}
