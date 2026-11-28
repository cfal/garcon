//! Ports `common/garcon-resume-agent.ts`.

use garcon_js::trim;
use serde::Serialize;
use serde_json::json;

use crate::chat_id::{ChatId, parse_chat_id};
use crate::garcon_agent_request::{
    GARCON_AGENT_PROMPT_MAX_BYTES, GarconAgentRequestOptions, parse_garcon_agent_request_options,
};
use crate::garcon_command_envelope::parse_garcon_prompt_envelope;

pub const GARCON_RESUME_AGENT_NAME: &str = "garcon-resume-agent";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ResumeAgentTag {
    ResumeAgent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GarconResumeAgentCommand {
    #[serde(rename = "type")]
    kind: ResumeAgentTag,
    #[serde(flatten)]
    pub request: GarconAgentRequestOptions,
    pub chat_id: ChatId,
    pub prompt: String,
}

pub fn parse_garcon_resume_agent(content: &str) -> Option<GarconResumeAgentCommand> {
    let envelope = parse_garcon_prompt_envelope(
        content,
        GARCON_RESUME_AGENT_NAME,
        &["ref", "async", "chat-id"],
    )?;
    if envelope.self_closing
        || trim(&envelope.body).is_empty()
        || envelope.body.len() > GARCON_AGENT_PROMPT_MAX_BYTES
    {
        return None;
    }
    let request = parse_garcon_agent_request_options(&json!(envelope.attributes))?;
    let chat_id = parse_chat_id(&json!(envelope.attributes.get("chat-id"))).ok()?;
    Some(GarconResumeAgentCommand {
        kind: ResumeAgentTag::ResumeAgent,
        request,
        chat_id,
        prompt: envelope.body,
    })
}
