//! Ports `server-agents/pi/src/agents/pi/pi-rpc-protocol.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use garcon_agents_common::shared::attachments::parse_attachment_data_url;
use garcon_contract::{
    agent_execution::AgentAttachment,
    chat_modes::PermissionMode,
    chat_types::{CompactionMessage, CompactionTrigger},
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    services::{AgentSteerRejectionReason, AgentSteerResult},
};
use garcon_js::{Number, json::as_number};

use crate::{
    pi_cli::build_pi_prompt,
    pi_rpc_client::{PiRpcCommandError, PiRpcResponse, PiRpcTransportError},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PiThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl PiThinkingLevel {
    const ALL: [Self; 7] = [
        Self::Off,
        Self::Minimal,
        Self::Low,
        Self::Medium,
        Self::High,
        Self::Xhigh,
        Self::Max,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PiInputCommand {
    Prompt,
    Steer,
}

impl PiInputCommand {
    fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Steer => "steer",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PiInputDisposition {
    Handled,
    Queued,
    Started,
}

pub fn pi_input_disposition(
    response: &PiRpcResponse,
    command: PiInputCommand,
) -> Result<PiInputDisposition, PiRpcTransportError> {
    if response.command == command.as_str() {
        match response
            .data
            .as_ref()
            .and_then(|data| data["disposition"].as_str())
        {
            Some("handled") => return Ok(PiInputDisposition::Handled),
            Some("queued") => return Ok(PiInputDisposition::Queued),
            Some("started") if command == PiInputCommand::Prompt => {
                return Ok(PiInputDisposition::Started);
            }
            _ => {}
        }
    }
    Err(PiRpcTransportError::new(
        format!("Pi returned an invalid {} disposition", command.as_str()),
        true,
    ))
}

#[derive(Debug, Serialize)]
pub struct PreparedPiRpcPrompt<'a> {
    pub message: String,
    pub images: Vec<PiRpcImage<'a>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRpcImage<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    pub data: &'a str,
    pub mime_type: String,
}

pub fn prepare_pi_rpc_prompt<'a>(
    command: &str,
    permission_mode: PermissionMode,
    attachments: &'a [AgentAttachment],
) -> Result<PreparedPiRpcPrompt<'a>, AgentIntegrationError> {
    let mut images = Vec::new();
    for attachment in attachments {
        let parts = parse_attachment_data_url(Some(&attachment.data));
        let Some(parts) = parts.filter(|parts| parts.mime_type.starts_with("image/")) else {
            let name = attachment.name.as_deref().unwrap_or("an attachment");
            return Err(AgentIntegrationError::new(
                AgentIntegrationErrorCode::PROVIDER_FAILURE,
                format!("Pi cannot attach {name}: only base64 image data URLs are supported"),
                false,
                None,
            ));
        };
        images.push(PiRpcImage {
            kind: "image",
            data: parts.base64,
            mime_type: parts.mime_type,
        });
    }
    let message = build_pi_prompt(command, permission_mode, !images.is_empty());
    Ok(PreparedPiRpcPrompt { message, images })
}

pub fn pi_compaction_message(event: &Value, timestamp: &str) -> Option<CompactionMessage> {
    if event["type"] != "compaction_end" || event["aborted"].as_bool() != Some(false) {
        return None;
    }
    let result = &event["result"];
    let summary = result["summary"].as_str()?.to_owned();
    let pre_tokens = pi_token_count(&result["tokensBefore"])?;
    let post_tokens = match result.get("estimatedTokensAfter") {
        Some(value) => Some(pi_token_count(value)?),
        None => None,
    };
    let trigger = match event["reason"].as_str() {
        Some("manual") => CompactionTrigger::Manual,
        Some("threshold" | "overflow") => CompactionTrigger::Auto,
        _ => return None,
    };
    Some(CompactionMessage {
        timestamp: timestamp.to_owned(),
        trigger,
        summary,
        pre_tokens: Some(pre_tokens),
        post_tokens,
    })
}

fn pi_token_count(value: &Value) -> Option<Number> {
    let number = as_number(value)?;
    (number.is_finite() && number >= 0.0).then_some(Number(number))
}

// Mirrors Pi's upward-first clamp for levels unsupported by the resolved model.
// https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/models.ts#L913-L945
pub fn resolve_pi_thinking_level(model: &Value, requested: PiThinkingLevel) -> PiThinkingLevel {
    use PiThinkingLevel as Level;

    if model["reasoning"].as_bool() != Some(true) {
        return Level::Off;
    }
    let requested_index = requested as usize;
    let map = &model["thinkingLevelMap"];
    let supported = |level: &Level| match map.get(level.as_str()) {
        Some(Value::Null) => false,
        Some(_) => true,
        None => !matches!(level, Level::Xhigh | Level::Max),
    };
    Level::ALL[requested_index..]
        .iter()
        .chain(Level::ALL[..requested_index].iter().rev())
        .copied()
        .find(supported)
        .unwrap_or(Level::Off)
}

pub fn rejected_pi_steer(reason: AgentSteerRejectionReason, message: &str) -> AgentSteerResult {
    AgentSteerResult::Rejected {
        reason,
        message: message.to_owned(),
    }
}

pub fn classify_pi_steer_rejection(error: &PiRpcCommandError) -> AgentSteerResult {
    use AgentSteerRejectionReason as Reason;

    let message = error.to_string().to_ascii_lowercase();
    if message.contains("extension command") || message.contains("cannot be queued") {
        return rejected_pi_steer(Reason::InvalidInput, "Pi rejected the steering input");
    }
    // Pi can enqueue while idle, so this message does not prove target-turn delivery.
    if ["not streaming", "not running", "no active turn"]
        .into_iter()
        .any(|text| message.contains(text))
    {
        return rejected_pi_steer(Reason::NoActiveTurn, "No active Pi turn");
    }
    rejected_pi_steer(Reason::ProviderRejected, "Pi rejected the steering input")
}
