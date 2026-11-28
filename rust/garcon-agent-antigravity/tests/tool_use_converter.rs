use garcon_agent_antigravity::tool_use_converter::{
    antigravity_tool_call, antigravity_tool_result_text, convert_antigravity_tool_use,
};
use garcon_agents_common::acp::event_converter::as_object;
use garcon_cases::{CaseError, markers, replay, text, unknown};
use garcon_contract::chat_types::ToolUseChatMessage;
use serde::Serialize;
use serde_json::{Map, Value};

fn wire<T: serde::de::DeserializeOwned>(value: impl Serialize) -> Result<T, CaseError> {
    let bytes = serde_json::to_vec(&value).map_err(undeliverable)?;
    garcon_js::json::from_slice(&bytes).map_err(undeliverable)
}

fn undeliverable(error: serde_json::Error) -> CaseError {
    CaseError::undeliverable(error.to_string())
}

fn instance(tool: &ToolUseChatMessage) -> Result<Value, CaseError> {
    use ToolUseChatMessage as Tool;
    let class = match tool {
        Tool::AgentMessage { .. } => "AgentMessageToolUseMessage",
        Tool::AntigravityEnterPlanMode { .. } => "AntigravityEnterPlanModeToolUseMessage",
        Tool::AntigravityExitPlanMode { .. } => "AntigravityExitPlanModeToolUseMessage",
        Tool::BackgroundTask { .. } => "BackgroundTaskToolUseMessage",
        Tool::Bash { .. } => "BashToolUseMessage",
        Tool::Edit { .. } => "EditToolUseMessage",
        Tool::External { .. } => "ExternalToolUseMessage",
        Tool::Glob { .. } => "GlobToolUseMessage",
        Tool::Grep { .. } => "GrepToolUseMessage",
        Tool::List { .. } => "ListToolUseMessage",
        Tool::Mcp { .. } => "McpToolUseMessage",
        Tool::Read { .. } => "ReadToolUseMessage",
        Tool::Schedule { .. } => "ScheduleToolUseMessage",
        Tool::Task { .. } => "TaskToolUseMessage",
        Tool::Unknown { .. } => "UnknownToolUseMessage",
        Tool::UpdatePlan { .. } => "UpdatePlanToolUseMessage",
        Tool::WebFetch { .. } => "WebFetchToolUseMessage",
        Tool::WebSearch { .. } => "WebSearchToolUseMessage",
        Tool::Write { .. } => "WriteToolUseMessage",
        _ => {
            return Err(CaseError::undeliverable(format!(
                "unexpected Antigravity tool {}",
                tool.message_type()
            )));
        }
    };
    Ok(markers::instance(class, wire::<Map<String, Value>>(tool)?))
}

fn required_text<'a>(function: &str, arg: Option<&'a Value>) -> Result<&'a str, CaseError> {
    text(function, arg)?.ok_or_else(|| CaseError::undeliverable("expected a string"))
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "antigravityToolCall" => {
            let raw = unknown(function, args.first())?;
            wire(antigravity_tool_call(as_object(&raw)))
        }
        "convertAntigravityToolUpdate" => {
            let timestamp = required_text(function, args.first())?;
            let raw = unknown(function, args.get(1))?;
            antigravity_tool_call(as_object(&raw)).map_or(Ok(Value::Null), |call| {
                instance(&convert_antigravity_tool_use(timestamp, &call))
            })
        }
        "antigravityToolResultText" => Ok(Value::from(antigravity_tool_result_text(
            required_text(function, args.first())?,
            required_text(function, args.get(1))?,
        ))),
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn recorded_antigravity_tool_use_cases_match() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/tool-use"),
        dispatch,
    );
}
