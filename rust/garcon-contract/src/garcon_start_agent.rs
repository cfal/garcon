//! Ports `common/garcon-start-agent.ts`.

use garcon_js::trim;
use serde::Serialize;
use serde_json::json;

use crate::chat_row_contracts::parse_chat_row_title;
use crate::executors::{ExecutorId, parse_executor_id};
use crate::garcon_agent_request::{
    GARCON_AGENT_PROMPT_MAX_BYTES, GarconAgentRequestOptions, parse_garcon_agent_request_options,
};
use crate::garcon_command_envelope::parse_garcon_prompt_envelope;

pub const GARCON_START_AGENT_NAME: &str = "garcon-start-agent";
pub const GARCON_START_PROMPT_MAX_BYTES: usize = GARCON_AGENT_PROMPT_MAX_BYTES;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum StartAgentTag {
    StartAgent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GarconStartAgentCommand {
    #[serde(rename = "type")]
    kind: StartAgentTag,
    #[serde(flatten)]
    pub request: GarconAgentRequestOptions,
    pub fork: bool,
    pub title: Option<String>,
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<ExecutorId>,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub prompt: String,
}

pub fn parse_garcon_start_agent(content: &str) -> Option<GarconStartAgentCommand> {
    let envelope = parse_garcon_prompt_envelope(
        content,
        GARCON_START_AGENT_NAME,
        &[
            "agent",
            "executor",
            "provider",
            "model",
            "reasoning-effort",
            "ref",
            "async",
            "fork",
            "title",
        ],
    )?;
    if trim(&envelope.body).is_empty() || envelope.self_closing {
        return None;
    }
    let mut attributes = envelope.attributes;
    let executor_id = parse_executor_id(&json!(attributes.get("executor")))?;
    let request = parse_garcon_agent_request_options(&json!(attributes))?;
    let fork = match attributes.get("fork").map(String::as_str) {
        None | Some("false") => false,
        Some("true") => true,
        _ => return None,
    };
    let title = parse_chat_row_title(&json!(attributes.get("title")))
        .ok()?
        .map(str::to_owned);
    if (attributes.contains_key("agent") || attributes.contains_key("provider"))
        && !attributes.contains_key("model")
    {
        return None;
    }
    if envelope.body.len() > GARCON_START_PROMPT_MAX_BYTES {
        return None;
    }
    Some(GarconStartAgentCommand {
        kind: StartAgentTag::StartAgent,
        request,
        fork,
        title,
        agent_id: attributes.shift_remove("agent"),
        executor_id: attributes.contains_key("executor").then_some(executor_id),
        provider_id: attributes.shift_remove("provider"),
        model: attributes.shift_remove("model"),
        reasoning_effort: attributes.shift_remove("reasoning-effort"),
        prompt: envelope.body,
    })
}
