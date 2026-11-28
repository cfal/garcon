use garcon_agents_common::shared::attachments::{
    AttachmentInput, append_text_attachment_context, attachment_document_block,
    document_attachments, image_attachments, parse_attachment_data_url,
};
use garcon_js::json::Opaque;
use serde_json::{Value, json};

pub struct ClaudeUserInputFrameOptions<'a> {
    pub content: &'a Opaque,
    pub session_id: &'a str,
    pub uuid: &'a str,
    pub priority: Option<ClaudeUserInputPriority>,
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeUserInputPriority {
    Next,
}

pub const CLAUDE_STEERING_PROMPT_PREFIX: &str =
    "The user sent steering guidance for the active task:\n\n";

pub fn build_claude_user_input_frame(
    options: ClaudeUserInputFrameOptions<'_>,
) -> serde_json::Result<String> {
    #[derive(serde::Serialize)]
    struct UserMessage<'a> {
        role: &'static str,
        content: &'a Opaque,
    }
    #[derive(serde::Serialize)]
    struct Frame<'a> {
        #[serde(rename = "type")]
        kind: &'static str,
        message: UserMessage<'a>,
        parent_tool_use_id: Option<&'static str>,
        session_id: &'a str,
        uuid: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        priority: Option<ClaudeUserInputPriority>,
    }
    serde_json::to_string(&Frame {
        kind: "user",
        message: UserMessage {
            role: "user",
            content: options.content,
        },
        parent_tool_use_id: None,
        session_id: options.session_id,
        uuid: options.uuid,
        priority: options.priority,
    })
}

pub fn build_claude_initial_user_content(
    command: &str,
    attachments: &[AttachmentInput<'_>],
) -> serde_json::Result<Opaque> {
    let prompt = append_text_attachment_context(command, attachments.iter().copied());
    let images = image_attachments(attachments.iter().copied());
    let documents = document_attachments(attachments.iter().copied());
    if images.is_empty() && documents.is_empty() {
        return Ok(Value::String(prompt.into_owned()).into());
    }
    let mut blocks = Vec::new();
    for image in images {
        if let Some(parts) = parse_attachment_data_url(Some(image.data)) {
            blocks.push(json!({ "type": "image", "source": { "type": "base64", "media_type": parts.mime_type, "data": parts.base64 } }));
        }
    }
    for document in documents {
        if let Some(block) = attachment_document_block(document) {
            blocks.push(serde_json::to_value(block)?);
        }
    }
    blocks.push(json!({ "type": "text", "text": prompt }));
    Ok(Value::Array(blocks).into())
}

pub fn build_claude_steering_user_content(input: &str) -> Opaque {
    json!([{ "type": "text", "text": format!("{CLAUDE_STEERING_PROMPT_PREFIX}{input}") }]).into()
}

pub fn claude_steering_inputs_from_native_content(content: &Value) -> Option<Vec<&str>> {
    let blocks = content.as_array().filter(|blocks| !blocks.is_empty())?;
    blocks
        .iter()
        .map(|block| {
            if block["type"] != "text" {
                return None;
            }
            block["text"]
                .as_str()?
                .strip_prefix(CLAUDE_STEERING_PROMPT_PREFIX)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, replay, text, unknown};

    use super::*;

    #[test]
    fn recorded_user_input_frames_match() {
        replay(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/user-input"),
            |function, args| match function {
                "buildClaudeUserInputFrame" => {
                    let input = unknown(function, args.first())?;
                    let content = Opaque::from_value(input["content"].clone());
                    let options = ClaudeUserInputFrameOptions {
                        content: &content,
                        session_id: input["sessionId"].as_str().unwrap(),
                        uuid: input["uuid"].as_str().unwrap(),
                        priority: (input["priority"] == "next")
                            .then_some(ClaudeUserInputPriority::Next),
                    };
                    Ok(Value::String(
                        build_claude_user_input_frame(options).unwrap(),
                    ))
                }
                "buildClaudeInitialUserContent" => {
                    let command = text(function, args.first())?.expect("recorded prompt");
                    let files = unknown(function, args.get(1))?;
                    let files: Vec<_> = files
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|file| AttachmentInput {
                            data: file["data"].as_str().unwrap(),
                            name: file["name"].as_str(),
                            mime_type: file["mimeType"].as_str(),
                        })
                        .collect();
                    Ok(build_claude_initial_user_content(command, &files)
                        .unwrap()
                        .into_value())
                }
                "buildClaudeSteeringUserContent" => {
                    let input = text(function, args.first())?.expect("recorded steering input");
                    Ok(build_claude_steering_user_content(input).into_value())
                }
                "claudeSteeringInputsFromNativeContent" => {
                    let input = unknown(function, args.first())?;
                    Ok(json!(claude_steering_inputs_from_native_content(&input)))
                }
                _ => Err(CaseError::unhandled(function)),
            },
        );
    }
}
