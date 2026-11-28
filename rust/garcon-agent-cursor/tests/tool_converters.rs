use garcon_agent_cursor::{
    tool_result_converter::normalize_cursor_tool_result_content,
    tool_use_converter::convert_cursor_tool_use,
};
use garcon_cases::{CaseError, markers, replay, text, unknown};
use garcon_contract::chat_types::ToolUseChatMessage as Tool;
use garcon_js::json::Opaque;
use serde_json::{Map, Value};

fn undeliverable(error: serde_json::Error) -> CaseError {
    CaseError::undeliverable(error.to_string())
}

#[test]
fn cursor_tool_use_matches_every_recorded_case() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/tool-use"),
        |function, args| {
            if function != "convertCursorToolUse" {
                return Err(CaseError::unhandled(function));
            }
            let timestamp = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("expected timestamp string"))?;
            let part = unknown(function, args.get(1))?;
            let message = convert_cursor_tool_use(timestamp, &part);
            let class = match message {
                Tool::ApplyPatch { .. } => "ApplyPatchToolUseMessage",
                Tool::Bash { .. } => "BashToolUseMessage",
                Tool::Edit { .. } => "EditToolUseMessage",
                Tool::Glob { .. } => "GlobToolUseMessage",
                Tool::Grep { .. } => "GrepToolUseMessage",
                Tool::List { .. } => "ListToolUseMessage",
                Tool::Read { .. } => "ReadToolUseMessage",
                Tool::Task { .. } => "TaskToolUseMessage",
                Tool::TodoRead { .. } => "TodoReadToolUseMessage",
                Tool::TodoWrite { .. } => "TodoWriteToolUseMessage",
                Tool::Unknown { .. } => "UnknownToolUseMessage",
                Tool::UpdatePlan { .. } => "UpdatePlanToolUseMessage",
                Tool::WebFetch { .. } => "WebFetchToolUseMessage",
                Tool::WebSearch { .. } => "WebSearchToolUseMessage",
                Tool::Write { .. } => "WriteToolUseMessage",
                _ => {
                    return Err(CaseError::undeliverable(format!(
                        "unexpected tool {}",
                        message.message_type()
                    )));
                }
            };
            let wire = garcon_js::json::from_slice::<Map<String, Value>>(
                &serde_json::to_vec(&message).map_err(undeliverable)?,
            )
            .map_err(undeliverable)?;
            Ok(markers::instance(class, wire))
        },
    );
}

#[test]
fn cursor_tool_result_matches_every_recorded_case() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/tool-result"),
        |function, args| {
            if function != "normalizeCursorToolResultContent" {
                return Err(CaseError::unhandled(function));
            }
            let name = unknown(function, args.first())?;
            let raw = Opaque::from_value(unknown(function, args.get(1))?.into_owned());
            let high = unknown(function, args.get(2))?;
            let normalized = normalize_cursor_tool_result_content(&name, Some(&raw), Some(&high));
            garcon_js::json::from_slice(&serde_json::to_vec(&normalized).map_err(undeliverable)?)
                .map_err(undeliverable)
        },
    );
}
