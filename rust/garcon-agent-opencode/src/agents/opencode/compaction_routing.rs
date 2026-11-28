//! Ports `server-agents/opencode/src/agents/opencode/compaction-routing.ts`.

use std::error::Error;

use garcon_contract::chat_types::{CompactionMessage, CompactionTrigger};
use garcon_interface::host::AgentLogger;
use garcon_js::to_iso_string;
use serde_json::Value;

use super::operation_routes::{OpenCodeCompactionPartAdoption, OpenCodeOperationRoutes, Route};
use super::sse_events::{
    OpenCodeAssistantTerminal, SseEvent, is_compaction_assistant, open_code_assistant_terminal,
};
use super::turn_events::{OpenCodeSession, OpenCodeTurnContext, SessionStatus};
use crate::js::{error, log_fields, prop, truthy};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenCodeCompactionPartDropCode {
    NoSession,
    SessionNotRunning,
    BeforePrompt,
    RouteRetired,
    InvalidIdentifiers,
    IdentityCollision,
}

impl OpenCodeCompactionPartDropCode {
    fn as_str(self) -> &'static str {
        match self {
            OpenCodeCompactionPartDropCode::NoSession => "COMPACTION_PART_NO_SESSION",
            OpenCodeCompactionPartDropCode::SessionNotRunning => {
                "COMPACTION_PART_SESSION_NOT_RUNNING"
            }
            OpenCodeCompactionPartDropCode::BeforePrompt => "COMPACTION_PART_BEFORE_PROMPT",
            OpenCodeCompactionPartDropCode::RouteRetired => "COMPACTION_PART_ROUTE_RETIRED",
            OpenCodeCompactionPartDropCode::InvalidIdentifiers => {
                "COMPACTION_PART_INVALID_IDENTIFIERS"
            }
            OpenCodeCompactionPartDropCode::IdentityCollision => {
                "COMPACTION_PART_IDENTITY_COLLISION"
            }
        }
    }
}

pub struct OpenCodeCompactionPartRouteInput<'a> {
    pub event: &'a SseEvent,
    pub logger: &'a dyn AgentLogger,
    pub operation_routes: &'a OpenCodeOperationRoutes,
    pub session: Option<&'a OpenCodeSession>,
    pub session_id: &'a str,
}

// Classifies the compaction control part of an event so it is adopted by the
// turn that owns it, or dropped once with a fixed warning.
pub fn adopt_open_code_compaction_part_route(
    input: OpenCodeCompactionPartRouteInput<'_>,
) -> Option<Route> {
    let OpenCodeCompactionPartRouteInput {
        event,
        logger,
        operation_routes,
        session,
        session_id,
    } = input;
    let part = event.property("part");
    let message_id = prop(part, "messageID").as_str().unwrap_or_default();
    let drop = |code| drop_compaction_part(logger, code, session_id, event);

    let Some(session) = session else {
        return drop(OpenCodeCompactionPartDropCode::NoSession);
    };
    let turn = session.borrow().turn.clone();
    if session.borrow().status != SessionStatus::Running {
        return drop(OpenCodeCompactionPartDropCode::SessionNotRunning);
    }
    // A manual compaction control part is the compaction turn's own source message:
    // adopting it supplies the provider identity the summarize route never returns.
    let manual_source = {
        let turn = turn.borrow();
        truthy(part) && prop(part, "auto") != &Value::Bool(true) && turn.compaction
    };
    if manual_source {
        if turn.borrow().provider_message_id.is_some() {
            return drop(OpenCodeCompactionPartDropCode::BeforePrompt);
        }
        let adopted = operation_routes.adopt_compaction_part(&turn, event);
        let route = match adopted {
            OpenCodeCompactionPartAdoption::Adopted { route } => route,
            OpenCodeCompactionPartAdoption::RouteRetired => {
                return drop(OpenCodeCompactionPartDropCode::RouteRetired);
            }
            OpenCodeCompactionPartAdoption::InvalidIdentifiers => {
                return drop(OpenCodeCompactionPartDropCode::InvalidIdentifiers);
            }
            OpenCodeCompactionPartAdoption::IdentityCollision => {
                return drop(OpenCodeCompactionPartDropCode::IdentityCollision);
            }
        };
        turn.borrow_mut().provider_message_id = Some(message_id.to_owned());
        logger.debug(
            "Adopted an OpenCode manual compaction source",
            Some(&log_fields([
                ("agentSessionId", Value::String(session_id.to_owned())),
                ("messageId", Value::String(message_id.to_owned())),
                ("partId", string_or_null(prop(part, "id"))),
            ])),
        );
        return Some(route);
    }

    if turn.borrow().provider_message_id.is_none() {
        return drop(OpenCodeCompactionPartDropCode::BeforePrompt);
    }

    let adopted = operation_routes.adopt_compaction_part(&turn, event);
    match adopted {
        OpenCodeCompactionPartAdoption::Adopted { route } => {
            if prop(part, "auto") == &Value::Bool(true) {
                turn.borrow_mut()
                    .automatic_compaction_message_ids
                    .insert(message_id.to_owned());
            }
            logger.debug(
                "Adopted an OpenCode compaction part",
                Some(&log_fields([
                    ("agentSessionId", Value::String(session_id.to_owned())),
                    ("partId", string_or_null(prop(part, "id"))),
                    ("messageId", string_or_null(prop(part, "messageID"))),
                ])),
            );
            Some(route)
        }
        OpenCodeCompactionPartAdoption::RouteRetired => {
            drop(OpenCodeCompactionPartDropCode::RouteRetired)
        }
        OpenCodeCompactionPartAdoption::InvalidIdentifiers => {
            drop(OpenCodeCompactionPartDropCode::InvalidIdentifiers)
        }
        OpenCodeCompactionPartAdoption::IdentityCollision => {
            drop(OpenCodeCompactionPartDropCode::IdentityCollision)
        }
    }
}

fn drop_compaction_part(
    logger: &dyn AgentLogger,
    code: OpenCodeCompactionPartDropCode,
    session_id: &str,
    event: &SseEvent,
) -> Option<Route> {
    let part = event.property("part");
    logger.warn(
        "Dropping an OpenCode compaction part",
        Some(&log_fields([
            ("code", Value::String(code.as_str().to_owned())),
            ("agentSessionId", Value::String(session_id.to_owned())),
            (
                "eventId",
                event.id.clone().map_or(Value::Null, Value::String),
            ),
            ("partId", string_or_null(prop(part, "id"))),
            ("messageId", string_or_null(prop(part, "messageID"))),
        ])),
    );
    None
}

// A string property as a log field writes it, and `null` for any other value.
fn string_or_null(value: &Value) -> Value {
    value
        .as_str()
        .map_or(Value::Null, |value| Value::String(value.to_owned()))
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeCompactionBoundary {
    pub row: CompactionMessage,
    // Manual boundaries retain their reload-stable point-fork anchor. Automatic
    // boundaries use the same live anchor but are intentionally absent after Reload.
    pub summary_message_id: String,
}

// Classifies every internal compaction event so control parts, summary parts,
// and the successful boundary all stay out of the ordinary message converter.
pub fn compaction_event_trigger(
    event: &SseEvent,
    turn: &OpenCodeTurnContext,
) -> Option<CompactionTrigger> {
    let turn = turn.borrow();
    if turn.compaction {
        return Some(CompactionTrigger::Manual);
    }
    let properties = &event.properties;
    let mut message_id = prop(prop(properties, "info"), "id");
    if message_id.is_null() {
        message_id = prop(prop(properties, "part"), "messageID");
    }
    if message_id.is_null() {
        message_id = prop(properties, "messageID");
    }
    (message_id
        .as_str()
        .is_some_and(|message_id| turn.automatic_compaction_message_ids.contains(message_id)))
    .then_some(CompactionTrigger::Auto)
}

// Only a summary assistant that finished successfully replaced prior context.
// Summary text and control parts stay internal to the native session.
pub fn compaction_boundary_row(
    event: &SseEvent,
    trigger: CompactionTrigger,
) -> Result<Option<OpenCodeCompactionBoundary>, Box<dyn Error>> {
    if event.kind != "message.updated" {
        return Ok(None);
    }
    let info = event.property("info");
    if !info.as_object().is_some_and(is_compaction_assistant) {
        return Ok(None);
    }
    let Some(terminal) = open_code_assistant_terminal(event) else {
        return Ok(None);
    };
    let message_id = match terminal {
        OpenCodeAssistantTerminal::Finished { message_id } => message_id,
        _ => return Ok(None),
    };
    let completed = prop(prop(info, "time"), "completed");
    if !completed.is_number() {
        return Ok(None);
    }
    // INFALLIBLE: a JSON number has a double.
    let completed = garcon_js::json::as_number(completed).expect("a JSON number");
    let timestamp =
        to_iso_string(completed as i64).map_err(|_| error("RangeError", "Invalid Date"))?;
    Ok(Some(OpenCodeCompactionBoundary {
        row: CompactionMessage {
            timestamp,
            trigger,
            summary: String::new(),
            pre_tokens: None,
            post_tokens: None,
        },
        summary_message_id: message_id,
    }))
}
