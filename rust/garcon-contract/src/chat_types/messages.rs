use garcon_js::{
    Number,
    json::{Opaque, as_number},
};
use serde::{Serialize, Serializer};
use serde_json::Value;

use crate::ask_user_question_response::{
    AskUserQuestionDecisionResponse, normalize_ask_user_question_decision_response,
};
use crate::async_user_questions::{
    AsyncQuestionSet, InvalidAsyncQuestionReply, parse_async_question_set,
};
use crate::chat_message_coercion::{
    ChatImage, ChatMessageMetadata, as_chat_images, as_optional_number, as_optional_string,
    parse_chat_message_metadata, str,
};
use crate::cli_presentation::{
    CliBodyDisclosure, CliPresentation, CliRowFormat, coerce_durable_cli_body_disclosure,
    coerce_durable_cli_presentation, is_cli_row_format,
};
use crate::command_output::{
    CommandOutcome, CommandOutputContext, command_outcome_text, is_command_output_data,
    parse_command_outcome, parse_command_output_context,
};
use crate::tool_result_message::ToolResultMessage;
use crate::user_message_presentation::{UserMessagePresentation, parse_user_message_presentation};

use super::{ToolUseChatMessage, parse_tool_use_message};

macro_rules! message_structs {
    ($($message:ident ($tag:literal) { $($(#[$wire_attr:meta])* $field:ident : $type:ty,)* })*) => {
        $(
            #[derive(Debug, Clone, PartialEq)]
            pub struct $message { $(pub $field: $type),* }

            impl $message {
                pub const TYPE: &'static str = $tag;
            }

            impl Serialize for $message {
                fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                    #[derive(Serialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Wire<'a> {
                        $($(#[$wire_attr])* $field: &'a $type,)*
                        #[serde(rename = "type")]
                        tag: &'static str,
                    }
                    Wire { $($field: &self.$field,)* tag: $tag }.serialize(serializer)
                }
            }
        )*
    };
}

message_structs! {
    UserMessage("user-message") {
        timestamp: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<ChatImage>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        metadata: Option<ChatMessageMetadata>,
        #[serde(skip_serializing_if = "Option::is_none")]
        presentation: Option<UserMessagePresentation>,
    }
    AssistantMessage("assistant-message") {
        timestamp: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        questions: Option<AsyncQuestionSet>,
    }
    CommandOutputMessage("command-output") {
        timestamp: String,
        command_id: String,
        channel: CommandOutputChannel,
        format: CommandOutputFormat,
        content: String,
        context: Option<CommandOutputContext>,
        offset: u64,
    }
    ThinkingMessage("thinking") {
        timestamp: String,
        content: String,
    }
    ErrorMessage("error") {
        timestamp: String,
        content: String,
    }
    CliRowMessage("cli-row") {
        timestamp: String,
        content: String,
        presentation: CliPresentation,
        format: CliRowFormat,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        disclosure: CliBodyDisclosure,
    }
    PermissionRequestMessage("permission-request") {
        timestamp: String,
        permission_occurrence_id: String,
        requested_tool: ToolUseChatMessage,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    }
    PermissionResolvedMessage("permission-resolved") {
        timestamp: String,
        permission_occurrence_id: String,
        allowed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        question_response: Option<AskUserQuestionDecisionResponse>,
    }
    PermissionCancelledMessage("permission-cancelled") {
        timestamp: String,
        permission_occurrence_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<Opaque>,
    }
    PermissionExpiredMessage("permission-expired") {
        timestamp: String,
        permission_occurrence_id: String,
    }
    CompactionMessage("compaction") {
        timestamp: String,
        trigger: CompactionTrigger,
        summary: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pre_tokens: Option<Number>,
        #[serde(skip_serializing_if = "Option::is_none")]
        post_tokens: Option<Number>,
    }
    AgentSwitchMessage("agent-switch") {
        timestamp: String,
        from_agent_id: String,
        to_agent_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        from_model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        to_model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        from_executor_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        to_executor_id: Option<String>,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResultMessage {
    pub timestamp: String,
    pub command_id: String,
    pub result: CommandOutcome,
    #[serde(rename = "type")]
    kind: CommandResultKind,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum CommandResultKind {
    CommandResult,
}

impl CommandResultMessage {
    pub const TYPE: &'static str = "command-result";

    pub fn new(timestamp: String, command_id: String, result: CommandOutcome) -> Self {
        let content = command_outcome_text(&result);
        Self {
            timestamp,
            command_id,
            result,
            kind: CommandResultKind::CommandResult,
            content,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandOutputChannel {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandOutputFormat {
    Plain,
    Markdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CompactionTrigger {
    Manual,
    Auto,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum NonNoticeChatMessage {
    User(UserMessage),
    Assistant(AssistantMessage),
    CommandOutput(CommandOutputMessage),
    CommandResult(CommandResultMessage),
    Thinking(ThinkingMessage),
    ToolUse(ToolUseChatMessage),
    ToolResult(ToolResultMessage),
    Error(ErrorMessage),
    CliRow(CliRowMessage),
    PermissionRequest(PermissionRequestMessage),
    PermissionResolved(PermissionResolvedMessage),
    PermissionCancelled(PermissionCancelledMessage),
    PermissionExpired(PermissionExpiredMessage),
    Compaction(CompactionMessage),
    AgentSwitch(AgentSwitchMessage),
}

pub fn parse_non_notice_chat_message(
    data: &Value,
) -> Result<Option<NonNoticeChatMessage>, InvalidAsyncQuestionReply> {
    use NonNoticeChatMessage as Message;
    let Some(raw) = data.as_object() else {
        return Ok(None);
    };
    if let Some(tool) = parse_tool_use_message(data) {
        return Ok(Some(Message::ToolUse(tool)));
    }
    let timestamp = || str(&data["timestamp"]).to_owned();
    let content = || str(&data["content"]).to_owned();
    let permission_occurrence_id = || nonempty_string(&data["permissionOccurrenceId"]);
    Ok(Some(match data["type"].as_str() {
        Some(UserMessage::TYPE) => {
            let presentation = parse_user_message_presentation(raw.get("presentation"))
                .ok()
                .flatten();
            Message::User(UserMessage {
                timestamp: timestamp(),
                content: content(),
                images: as_chat_images(&data["images"]),
                metadata: parse_chat_message_metadata(&data["metadata"])?,
                presentation,
            })
        }
        Some(AssistantMessage::TYPE) => Message::Assistant(AssistantMessage {
            timestamp: timestamp(),
            content: content(),
            questions: parse_async_question_set(&data["questions"]),
        }),
        Some(CommandOutputMessage::TYPE) => {
            let context = parse_command_output_context(&data["context"]);
            if (raw.get("context") != Some(&Value::Null) && context.is_none())
                || !is_command_output_data(data)
            {
                return Ok(None);
            }
            Message::CommandOutput(CommandOutputMessage {
                timestamp: timestamp(),
                command_id: str(&data["commandId"]).to_owned(),
                channel: if data["channel"] == "stdout" {
                    CommandOutputChannel::Stdout
                } else {
                    CommandOutputChannel::Stderr
                },
                format: if data["format"] == "markdown" {
                    CommandOutputFormat::Markdown
                } else {
                    CommandOutputFormat::Plain
                },
                content: content(),
                context,
                // The predicate already validated the offset as a nonnegative safe integer.
                offset: as_number(&data["offset"]).unwrap_or_default() as u64,
            })
        }
        Some(CommandResultMessage::TYPE) => {
            let Some(result) = parse_command_outcome(&data["result"]) else {
                return Ok(None);
            };
            let Some(command_id) = nonempty_string(&data["commandId"]) else {
                return Ok(None);
            };
            Message::CommandResult(CommandResultMessage::new(timestamp(), command_id, result))
        }
        Some(ThinkingMessage::TYPE) => Message::Thinking(ThinkingMessage {
            timestamp: timestamp(),
            content: content(),
        }),
        Some("tool-result") => Message::ToolResult(ToolResultMessage::from_data(raw)),
        Some(ErrorMessage::TYPE) => Message::Error(ErrorMessage {
            timestamp: timestamp(),
            content: content(),
        }),
        Some(CliRowMessage::TYPE) => Message::CliRow(CliRowMessage {
            timestamp: timestamp(),
            content: content(),
            presentation: coerce_durable_cli_presentation(&data["presentation"]),
            format: is_cli_row_format(&data["format"]).unwrap_or(CliRowFormat::Plain),
            title: nonempty_string(&data["title"]),
            disclosure: coerce_durable_cli_body_disclosure(&data["disclosure"]),
        }),
        Some(PermissionRequestMessage::TYPE) => {
            let requested_tool = parse_non_notice_chat_message(&data["requestedTool"])?;
            let (Some(id), Some(Message::ToolUse(requested_tool))) =
                (permission_occurrence_id(), requested_tool)
            else {
                return Ok(None);
            };
            Message::PermissionRequest(PermissionRequestMessage {
                timestamp: timestamp(),
                permission_occurrence_id: id,
                requested_tool,
                reason: nonempty_string(&data["reason"]),
            })
        }
        Some(PermissionResolvedMessage::TYPE) => {
            let Some(id) = permission_occurrence_id() else {
                return Ok(None);
            };
            Message::PermissionResolved(PermissionResolvedMessage {
                timestamp: timestamp(),
                permission_occurrence_id: id,
                allowed: json_truthy(&data["allowed"]),
                question_response: normalize_ask_user_question_decision_response(
                    &data["questionResponse"],
                ),
            })
        }
        Some(PermissionCancelledMessage::TYPE) => {
            let Some(id) = permission_occurrence_id() else {
                return Ok(None);
            };
            Message::PermissionCancelled(PermissionCancelledMessage {
                timestamp: timestamp(),
                permission_occurrence_id: id,
                reason: raw.get("reason").cloned().map(Opaque::from_value),
            })
        }
        Some(PermissionExpiredMessage::TYPE) => {
            let Some(id) = permission_occurrence_id() else {
                return Ok(None);
            };
            Message::PermissionExpired(PermissionExpiredMessage {
                timestamp: timestamp(),
                permission_occurrence_id: id,
            })
        }
        Some(CompactionMessage::TYPE) => Message::Compaction(CompactionMessage {
            timestamp: timestamp(),
            trigger: if data["trigger"] == "auto" {
                CompactionTrigger::Auto
            } else {
                CompactionTrigger::Manual
            },
            summary: str(&data["summary"]).to_owned(),
            pre_tokens: as_optional_number(&data["preTokens"]),
            post_tokens: as_optional_number(&data["postTokens"]),
        }),
        Some(AgentSwitchMessage::TYPE) => Message::AgentSwitch(AgentSwitchMessage {
            timestamp: timestamp(),
            from_agent_id: str(&data["fromAgentId"]).to_owned(),
            to_agent_id: str(&data["toAgentId"]).to_owned(),
            from_model: as_optional_string(&data["fromModel"]).map(str::to_owned),
            to_model: as_optional_string(&data["toModel"]).map(str::to_owned),
            from_executor_id: as_optional_string(&data["fromExecutorId"]).map(str::to_owned),
            to_executor_id: as_optional_string(&data["toExecutorId"]).map(str::to_owned),
        }),
        _ => return Ok(None),
    }))
}

fn nonempty_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub fn parse_non_notice_chat_messages(
    data: &Value,
) -> Result<Vec<NonNoticeChatMessage>, InvalidAsyncQuestionReply> {
    let Some(items) = data.as_array() else {
        return Ok(Vec::new());
    };
    let mut messages = Vec::with_capacity(items.len());
    for item in items {
        if let Some(message) = parse_non_notice_chat_message(item)? {
            messages.push(message);
        }
    }
    Ok(messages)
}

fn json_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(_) => as_number(value).is_some_and(|value| value != 0.0 && !value.is_nan()),
        Value::Array(_) | Value::Object(_) => true,
    }
}
