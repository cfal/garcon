//! Ports `server-agents/common/src/acp/runtime-helpers.ts`.

use std::collections::{BTreeMap, HashSet};
use std::error::Error;
use std::future::Future;

use garcon_base::errors::error_metadata;
use garcon_contract::chat_modes::PermissionMode;
use garcon_contract::chat_types::ToolUseChatMessage;
use garcon_js::json::Opaque;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::task::{JoinHandle, spawn_local};

use crate::shared::normalize_util::normalize_tool_input;

use super::event_converter::as_string;
use super::runtime_types::AcpExecutionRequest;
use super::timers::delay;

pub fn build_prompt_fallback(request: &AcpExecutionRequest) -> Vec<Value> {
    vec![json!({"type": "text", "text": request.command})]
}

pub fn build_env_fallback(request: &AcpExecutionRequest) -> BTreeMap<String, Option<String>> {
    std::env::vars_os()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                Some(value.to_string_lossy().into_owned()),
            )
        })
        .chain(
            request
                .env_overrides
                .iter()
                .map(|(name, value)| (name.clone(), Some(value.clone()))),
        )
        .collect()
}

pub fn automatic_permission_choice(
    mode: PermissionMode,
    kind: Option<&Value>,
    accepts_edits_on_client: bool,
) -> Option<AcpPermissionChoice> {
    if matches!(
        mode,
        PermissionMode::ManualBypass | PermissionMode::BypassPermissions
    ) {
        return Some(AcpPermissionChoice::AutoApprove);
    }
    (mode == PermissionMode::AcceptEdits
        && accepts_edits_on_client
        && kind.and_then(as_string) == Some("edit"))
    .then_some(AcpPermissionChoice::AllowOnce)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AcpPermissionChoice {
    AllowOnce,
    AllowAlways,
    AutoApprove,
    Reject,
}

#[derive(Clone, Copy)]
enum ChoiceKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
}

impl ChoiceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::AllowOnce => "allow_once",
            Self::AllowAlways => "allow_always",
            Self::RejectOnce => "reject_once",
        }
    }

    fn untyped_ids(self) -> &'static [&'static str] {
        match self {
            Self::AllowOnce => &["allow-once", "allow_once", "allow", "approve"],
            Self::AllowAlways => &["allow-always", "allow_always"],
            Self::RejectOnce => &["reject-once", "reject_once", "reject", "deny"],
        }
    }
}

impl AcpPermissionChoice {
    fn kinds(self) -> &'static [ChoiceKind] {
        match self {
            Self::AllowOnce => &[ChoiceKind::AllowOnce],
            Self::AllowAlways => &[ChoiceKind::AllowAlways, ChoiceKind::AllowOnce],
            Self::AutoApprove => &[ChoiceKind::AllowOnce, ChoiceKind::AllowAlways],
            Self::Reject => &[ChoiceKind::RejectOnce],
        }
    }
}

fn first_present<'a>(object: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .filter_map(|key| object.get(*key))
        .find(|value| !value.is_null())
}

fn option_id_from(option: &Map<String, Value>) -> Option<&str> {
    first_present(option, &["optionId", "option_id", "id"]).and_then(as_string)
}

/// Cancels rather than selecting an option whose meaning is unknown.
pub fn permission_choice_outcome(
    options: &[&Map<String, Value>],
    choice: AcpPermissionChoice,
) -> Value {
    let untyped: HashSet<_> = options
        .iter()
        .filter(|option| !option.contains_key("kind"))
        .filter_map(|option| option_id_from(option))
        .collect();
    for kind in choice.kinds() {
        for option in options {
            if option.get("kind").and_then(as_string) == Some(kind.as_str())
                && let Some(id) = option_id_from(option).filter(|id| !id.is_empty())
            {
                return permission_outcome(id);
            }
        }
        if let Some(id) = kind.untyped_ids().iter().find(|id| untyped.contains(**id)) {
            return permission_outcome(id);
        }
    }
    permission_cancelled_outcome()
}

pub fn permission_outcome(option_id: &str) -> Value {
    json!({"outcome": {"outcome": "selected", "optionId": option_id}})
}

pub fn permission_cancelled_outcome() -> Value {
    json!({"outcome": {"outcome": "cancelled"}})
}

pub fn humanize_error(error: &(dyn Error + 'static)) -> String {
    let message = error.to_string();
    if message.is_empty() {
        error_metadata(error).name.to_owned()
    } else {
        message
    }
}

/// Describes a permission request the agent's converter did not recognize.
pub fn fallback_permission_tool_use(
    tool_call: &Map<String, Value>,
    occurrence_id: &str,
    timestamp: &str,
) -> ToolUseChatMessage {
    let tool_id = first_present(tool_call, &["toolCallId", "callId", "id"])
        .and_then(as_string)
        .unwrap_or(occurrence_id);
    let raw_name = first_present(
        tool_call,
        &["toolName", "tool_name", "kind", "title", "name"],
    )
    .and_then(as_string)
    .unwrap_or("Permission");
    let raw_input = first_present(tool_call, &["rawInput", "raw_input", "input", "args"])
        .cloned()
        .map(Opaque::from_value);
    let input = normalize_tool_input(raw_input.as_ref());
    let input = if input.as_object().is_some_and(Map::is_empty) {
        let mut input = Map::new();
        for key in ["locations", "content"] {
            if let Some(items) = tool_call
                .get(key)
                .and_then(Value::as_array)
                .filter(|items| !items.is_empty())
            {
                input.insert(key.to_owned(), Value::Array(items.clone()));
            }
        }
        if let Some(title) = tool_call
            .get("title")
            .and_then(as_string)
            .filter(|title| !title.is_empty())
        {
            input.insert("title".to_owned(), Value::String(title.to_owned()));
        }
        Opaque::from_value(Value::Object(input))
    } else {
        input
    };
    ToolUseChatMessage::Unknown {
        timestamp: timestamp.to_owned(),
        tool_id: tool_id.to_owned(),
        raw_name: raw_name.to_owned(),
        input,
    }
}

/// Runs the callback only if settlement has not occurred before the deadline.
pub fn unless_settled(
    settled: impl Future<Output = ()> + 'static,
    ms: f64,
    on_timeout: impl FnOnce() + 'static,
) -> JoinHandle<()> {
    let deadline = tokio::time::sleep(delay(ms));
    spawn_local(async move {
        tokio::select! {
            biased;
            () = settled => {}
            () = deadline => on_timeout(),
        }
    })
}
