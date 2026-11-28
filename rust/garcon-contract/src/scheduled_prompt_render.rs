//! Ports `common/scheduled-prompt-render.ts`.

use garcon_js::{trim, utf16};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    chat_id::{ChatId, parse_chat_id},
    scheduled_prompts::SCHEDULED_PROMPT_MAX_LENGTH,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderScheduledPromptRequest {
    pub chat_id: ChatId,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderScheduledPromptResponse {
    pub success: bool,
    pub chat_id: ChatId,
    pub expanded_text: String,
}

fn valid_prompt(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|text| !trim(text).is_empty() && utf16::len(text) <= SCHEDULED_PROMPT_MAX_LENGTH)
}

pub fn parse_render_scheduled_prompt_request(
    value: &Value,
) -> Option<RenderScheduledPromptRequest> {
    let raw = value.as_object()?;
    let prompt = valid_prompt(raw.get("prompt")?)?.to_owned();
    let chat_id = parse_chat_id(raw.get("chatId")?).ok()?;
    Some(RenderScheduledPromptRequest { chat_id, prompt })
}

pub fn parse_render_scheduled_prompt_response(
    value: &Value,
) -> Option<RenderScheduledPromptResponse> {
    let raw = value.as_object()?;
    if raw.get("success")?.as_bool() != Some(true) {
        return None;
    }
    let expanded_text = valid_prompt(raw.get("expandedText")?)?.to_owned();
    let chat_id = parse_chat_id(raw.get("chatId")?).ok()?;
    Some(RenderScheduledPromptResponse {
        success: true,
        chat_id,
        expanded_text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_literal_whitespace_and_the_prospective_chat_id() {
        let mut request = json!({"chatId":"1783725900000200","prompt":"  literal \n"});
        assert_eq!(
            json!(parse_render_scheduled_prompt_request(&request).unwrap()),
            request
        );
        request["chatId"] = json!("invalid");
        assert!(parse_render_scheduled_prompt_request(&request).is_none());
    }
}
