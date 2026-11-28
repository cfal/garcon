use garcon_base::errors::{ErrorInput, js_string};
use garcon_contract::{
    chat_command_contracts::PermissionDecisionPayload,
    chat_types::{PermissionRequestMessage, ToolUseChatMessage},
};
use garcon_js::{
    clock::{Clock, InvalidTimeValue, to_iso_string},
    json::{Opaque, as_number},
};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::user_input::{
    CODEX_USER_INPUT_METHOD, CodexUserInputError, CodexUserInputResponse, codex_user_input_message,
    codex_user_input_response,
};

use super::protocol::{JsonRpcId, JsonRpcServerRequest};

pub mod registry;

#[derive(Debug, Clone, PartialEq)]
pub struct CodexPendingApproval {
    pub permission_occurrence_id: String,
    pub request_id: JsonRpcId,
    pub chat_id: String,
    pub method: String,
    pub params: Opaque,
}

#[derive(Debug, thiserror::Error)]
pub enum CodexApprovalError {
    #[error("Codex write-stdin approval requires approvalId and itemId")]
    MissingWriteStdinIdentity,
    #[error("Codex write-stdin approval requires approvalId")]
    MissingWriteStdinApproval,
    #[error("Unsupported Codex command approval kind")]
    UnsupportedCommandKind,
    #[error(transparent)]
    UserInput(#[from] CodexUserInputError),
    #[error(transparent)]
    Time(#[from] InvalidTimeValue),
}

pub fn is_approval_request(request: &JsonRpcServerRequest) -> bool {
    matches!(
        request.method.as_str(),
        CODEX_USER_INPUT_METHOD
            | "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "execCommandApproval"
            | "applyPatchApproval"
    )
}

pub fn create_pending_approval(
    chat_id: &str,
    request: &JsonRpcServerRequest,
    occurrence_id: impl FnOnce() -> String,
) -> CodexPendingApproval {
    CodexPendingApproval {
        permission_occurrence_id: occurrence_id(),
        request_id: request.id.clone(),
        chat_id: chat_id.into(),
        method: request.method.clone(),
        params: request
            .params
            .as_ref()
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| Opaque::from_value(json!({}))),
    }
}

pub fn build_approval_message(
    pending: &CodexPendingApproval,
    clock: &dyn Clock,
) -> Result<PermissionRequestMessage, CodexApprovalError> {
    let now = to_iso_string(clock.now_ms())?;
    let params = &pending.params;
    let field = |name: &str| nonempty_string(&params[name]);
    let tool = match pending.method.as_str() {
        CODEX_USER_INPUT_METHOD => {
            codex_user_input_message(&now, &params["itemId"], &params["questions"])?
        }
        "item/commandExecution/requestApproval" => {
            let approval_id = field("approvalId");
            let item_id = field("itemId");
            match command_approval_kind(pending)? {
                CommandApprovalKind::WriteStdin => {
                    let (Some(approval_id), Some(item_id)) = (approval_id, item_id) else {
                        return Err(CodexApprovalError::MissingWriteStdinIdentity);
                    };
                    let mut input = json!({"itemId": item_id});
                    if let Some(reason) = field("reason") {
                        input["reason"] = json!(reason);
                    }
                    ToolUseChatMessage::WriteStdin {
                        timestamp: now.clone(),
                        tool_id: approval_id.into(),
                        input: Opaque::from_value(input),
                    }
                }
                CommandApprovalKind::Command => ToolUseChatMessage::Bash {
                    timestamp: now.clone(),
                    tool_id: approval_id
                        .or(item_id)
                        .unwrap_or(&pending.permission_occurrence_id)
                        .into(),
                    command: field("command")
                        .map(str::to_owned)
                        .or_else(|| network_approval_label(&params["networkApprovalContext"]))
                        .or_else(|| field("reason").map(str::to_owned))
                        .unwrap_or_else(|| "Command approval requested".into()),
                    description: None,
                },
            }
        }
        "execCommandApproval" => ToolUseChatMessage::Bash {
            timestamp: now.clone(),
            tool_id: field("callId")
                .or_else(|| field("itemId"))
                .unwrap_or(&pending.permission_occurrence_id)
                .into(),
            command: params["command"]
                .as_array()
                .map(|arguments| {
                    arguments
                        .iter()
                        .map(|value| js_string(ErrorInput::Json(value)))
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_else(|| {
                    field("reason")
                        .unwrap_or("Command approval requested")
                        .into()
                }),
            description: None,
        },
        method => {
            let tool_id = field("itemId")
                .or_else(|| field("callId"))
                .unwrap_or(&pending.permission_occurrence_id)
                .into();
            if matches!(
                method,
                "item/fileChange/requestApproval" | "applyPatchApproval"
            ) {
                ToolUseChatMessage::Edit {
                    timestamp: now.clone(),
                    tool_id,
                    file_path: None,
                    old_string: None,
                    new_string: None,
                    changes: None,
                }
            } else {
                let permissions = params["permissions"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                ToolUseChatMessage::RequestPermissions {
                    timestamp: now.clone(),
                    tool_id,
                    permissions: Opaque::from_value(Value::Object(permissions)),
                    reason: params["reason"].as_str().map(str::to_owned),
                }
            }
        }
    };
    Ok(PermissionRequestMessage {
        timestamp: now,
        permission_occurrence_id: pending.permission_occurrence_id.clone(),
        requested_tool: tool,
        reason: None,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum CodexApprovalResponse {
    Questions(CodexUserInputResponse),
    Decision {
        decision: CodexApprovalDecision,
    },
    Permissions {
        permissions: Opaque,
        scope: CodexPermissionScope,
    },
    Empty {},
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexApprovalDecision {
    Accept,
    Cancel,
    Decline,
    AcceptForSession,
    Approved,
    Denied,
    #[serde(rename = "approved_for_session")]
    ApprovedForSession,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CodexPermissionScope {
    Turn,
    Session,
}

pub fn build_approval_response(
    pending: &CodexPendingApproval,
    decision: &PermissionDecisionPayload,
    clock: &dyn Clock,
) -> Result<CodexApprovalResponse, CodexApprovalError> {
    use CodexApprovalDecision as Decision;
    let always = decision.always_allow == Some(true);
    let mode = match pending.method.as_str() {
        CODEX_USER_INPUT_METHOD => {
            let tool = codex_user_input_message(
                &to_iso_string(clock.now_ms())?,
                &pending.params["itemId"],
                &pending.params["questions"],
            )?;
            return Ok(CodexApprovalResponse::Questions(codex_user_input_response(
                &tool, decision,
            )?));
        }
        "item/commandExecution/requestApproval" => match command_approval_kind(pending)? {
            CommandApprovalKind::WriteStdin => {
                if nonempty_string(&pending.params["approvalId"]).is_none() {
                    return Err(CodexApprovalError::MissingWriteStdinApproval);
                }
                if decision.allow {
                    Decision::Accept
                } else {
                    Decision::Cancel
                }
            }
            CommandApprovalKind::Command => command_decision(decision.allow, always),
        },
        "item/fileChange/requestApproval" => command_decision(decision.allow, always),
        "item/permissions/requestApproval" => {
            let mut permissions = Map::new();
            if decision.allow {
                let requested = &pending.params["permissions"];
                for key in ["network", "fileSystem"] {
                    if let Some(value) = requested.get(key).filter(|value| truthy(value)) {
                        permissions.insert(key.into(), value.clone());
                    }
                }
            }
            return Ok(CodexApprovalResponse::Permissions {
                permissions: Opaque::from_value(Value::Object(permissions)),
                scope: if decision.allow && always {
                    CodexPermissionScope::Session
                } else {
                    CodexPermissionScope::Turn
                },
            });
        }
        "execCommandApproval" | "applyPatchApproval" => match (decision.allow, always) {
            (false, _) => Decision::Denied,
            (true, true) => Decision::ApprovedForSession,
            (true, false) => Decision::Approved,
        },
        _ => return Ok(CodexApprovalResponse::Empty {}),
    };
    Ok(CodexApprovalResponse::Decision { decision: mode })
}

fn command_decision(allow: bool, always: bool) -> CodexApprovalDecision {
    match (allow, always) {
        (false, _) => CodexApprovalDecision::Decline,
        (true, true) => CodexApprovalDecision::AcceptForSession,
        (true, false) => CodexApprovalDecision::Accept,
    }
}

#[derive(Clone, Copy)]
enum CommandApprovalKind {
    Command,
    WriteStdin,
}

fn command_approval_kind(
    pending: &CodexPendingApproval,
) -> Result<CommandApprovalKind, CodexApprovalError> {
    match pending.params.get("kind") {
        None => Ok(CommandApprovalKind::Command),
        Some(Value::String(kind)) if kind == "command" => Ok(CommandApprovalKind::Command),
        Some(Value::String(kind)) if kind == "writeStdin" => Ok(CommandApprovalKind::WriteStdin),
        // Human-only checkpoints require a capability Garcon does not advertise.
        _ => Err(CodexApprovalError::UnsupportedCommandKind),
    }
}

fn network_approval_label(context: &Value) -> Option<String> {
    let host = nonempty_string(&context["host"])?;
    Some(match nonempty_string(&context["protocol"]) {
        Some(protocol) => format!("Network access to {protocol}://{host}"),
        None => format!("Network access to {host}"),
    })
}

fn nonempty_string(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| !value.is_empty())
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(_) => as_number(value).is_some_and(|value| value != 0.0),
        Value::Array(_) | Value::Object(_) => true,
    }
}
