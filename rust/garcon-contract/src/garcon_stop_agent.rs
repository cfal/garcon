//! Ports `common/garcon-stop-agent.ts`.

use serde::Serialize;
use serde_json::json;

use crate::chat_id::{ChatId, parse_chat_id};
use crate::garcon_command_envelope::parse_garcon_command_envelope;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum StopAgentTag {
    StopAgent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GarconStopAgentCommand {
    #[serde(rename = "type")]
    kind: StopAgentTag,
    pub chat_id: ChatId,
    pub remove: bool,
}

pub fn parse_garcon_stop_agent(content: &str) -> Option<GarconStopAgentCommand> {
    let envelope =
        parse_garcon_command_envelope(content, "garcon-stop-agent", &["chat-id", "remove"])?;
    if !envelope.self_closing {
        return None;
    }
    let remove = match envelope.attributes.get("remove").map(String::as_str) {
        None | Some("false") => false,
        Some("true") => true,
        _ => return None,
    };
    let chat_id = parse_chat_id(&json!(envelope.attributes.get("chat-id"))).ok()?;
    Some(GarconStopAgentCommand {
        kind: StopAgentTag::StopAgent,
        chat_id,
        remove,
    })
}
