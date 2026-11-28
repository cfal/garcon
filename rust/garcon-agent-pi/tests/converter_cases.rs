use garcon_agent_pi::{
    message_converter::{ConvertPiMessageOptions, convert_pi_message, pi_final_response},
    tool_use_converter::convert_pi_tool_use,
};
use garcon_cases::{CaseError, markers, replay, round_tripped, text};
use garcon_contract::chat_types::{ChatMessage, ToolUseChatMessage};
use garcon_js::{
    ManualClock,
    json::{self as js_json, Opaque},
};
use serde::Serialize;
use serde_json::Value;

fn undeliverable(error: impl std::fmt::Display) -> CaseError {
    CaseError::undeliverable(error.to_string())
}

fn wire(value: impl Serialize) -> Result<Value, CaseError> {
    let bytes = serde_json::to_vec(&value).map_err(undeliverable)?;
    js_json::from_slice(&bytes).map_err(undeliverable)
}

fn instance(class: &str, value: impl Serialize) -> Result<Value, CaseError> {
    let Value::Object(fields) = wire(value)? else {
        return Err(undeliverable("expected a message object"));
    };
    Ok(markers::instance(class, fields))
}

fn encode_tool(row: &ToolUseChatMessage) -> Result<Value, CaseError> {
    use ToolUseChatMessage as Row;
    let class = match row {
        Row::Mcp { .. } => "McpToolUseMessage",
        Row::Exec { .. } => "ExecToolUseMessage",
        Row::PiToolSearch { .. } => "PiToolSearchToolUseMessage",
        Row::Bash { .. } => "BashToolUseMessage",
        Row::Read { .. } => "ReadToolUseMessage",
        Row::List { .. } => "ListToolUseMessage",
        Row::Write { .. } => "WriteToolUseMessage",
        Row::Edit { .. } => "EditToolUseMessage",
        Row::Grep { .. } => "GrepToolUseMessage",
        Row::Glob { .. } => "GlobToolUseMessage",
        Row::Unknown { .. } => "UnknownToolUseMessage",
        _ => return Err(undeliverable("unexpected Pi tool message")),
    };
    instance(class, row)
}

fn encode_message(message: &ChatMessage) -> Result<Value, CaseError> {
    let class = match message {
        ChatMessage::Assistant(_) => "AssistantMessage",
        ChatMessage::Thinking(_) => "ThinkingMessage",
        ChatMessage::ToolResult(_) => "ToolResultMessage",
        ChatMessage::User(_) => "UserMessage",
        ChatMessage::ToolUse(tool) => return encode_tool(tool),
        _ => return Err(undeliverable("unexpected Pi message")),
    };
    instance(class, message)
}

#[test]
fn recorded_pi_tool_use_matches() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/tool-use-converter"
        ),
        |function, args| {
            if function != "convertPiToolUse" {
                return Err(CaseError::unhandled(function));
            }
            let string = |index| {
                text(function, args.get(index))?.ok_or_else(|| undeliverable("expected a string"))
            };
            let input = round_tripped(function, args.get(3))?
                .map(|value| Opaque::from_value(value.into_owned()));
            encode_tool(&convert_pi_tool_use(
                string(0)?,
                string(1)?,
                string(2)?,
                input.as_ref(),
            ))
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn recorded_pi_messages_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/message-converter"),
        |function, args| {
            let raw = round_tripped(function, args.first())?;
            let raw = raw.as_deref().unwrap_or(&Value::Null);
            match function {
                "piFinalResponse" => {
                    pi_final_response(raw).map_or_else(|| Ok(markers::undefined()), wire)
                }
                "convertPiMessage" => {
                    let options = round_tripped(function, args.get(1))?;
                    let enabled = |name| {
                        options
                            .as_deref()
                            .and_then(|options| options[name].as_bool())
                            .unwrap_or(true)
                    };
                    let options = ConvertPiMessageOptions {
                        include_tool_calls: enabled("includeToolCalls"),
                        include_tool_results: enabled("includeToolResults"),
                        include_user: enabled("includeUser"),
                    };
                    let messages = convert_pi_message(raw, options, &ManualClock::new(0))
                        .map_err(|error| CaseError::new("RangeError", error.to_string()))?;
                    messages
                        .iter()
                        .map(encode_message)
                        .collect::<Result<Vec<_>, _>>()
                        .map(Value::Array)
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
