use garcon_agent_claude::{
    permission_tool_converter::convert_claude_permission_request,
    tool_use_converter::convert_claude_tool_use,
};
use garcon_cases::{
    CaseError, ReplayOptions, ResultOrderException, markers, replay_with_options, text, unknown,
};
use garcon_contract::chat_types::ToolUseChatMessage;
use garcon_interface::producer::AgentRequestedPermission;
use serde_json::Value;

const QUESTION_ORDER: &str = "the original converter writes allowMultiple before header; the shared parser applied by readers writes header first";

fn encode(row: &ToolUseChatMessage) -> Value {
    use ToolUseChatMessage as Row;
    let class = match row {
        Row::ApplyPatch { .. } => "ApplyPatchToolUseMessage",
        Row::AskUserQuestion { .. } => "AskUserQuestionToolUseMessage",
        Row::BackgroundTask { .. } => "BackgroundTaskToolUseMessage",
        Row::Bash { .. } => "BashToolUseMessage",
        Row::ClaudeMonitor { .. } => "ClaudeMonitorToolUseMessage",
        Row::ClaudeToolSearch { .. } => "ClaudeToolSearchToolUseMessage",
        Row::Edit { .. } => "EditToolUseMessage",
        Row::EnterPlanMode { .. } => "EnterPlanModeToolUseMessage",
        Row::ExitPlanMode { .. } => "ExitPlanModeToolUseMessage",
        Row::Glob { .. } => "GlobToolUseMessage",
        Row::Grep { .. } => "GrepToolUseMessage",
        Row::Read { .. } => "ReadToolUseMessage",
        Row::Schedule { .. } => "ScheduleToolUseMessage",
        Row::Task { .. } => "TaskToolUseMessage",
        Row::TodoRead { .. } => "TodoReadToolUseMessage",
        Row::TodoWrite { .. } => "TodoWriteToolUseMessage",
        Row::Unknown { .. } => "UnknownToolUseMessage",
        Row::UpdatePlan { .. } => "UpdatePlanToolUseMessage",
        Row::WebFetch { .. } => "WebFetchToolUseMessage",
        Row::WebSearch { .. } => "WebSearchToolUseMessage",
        Row::WriteStdin { .. } => "WriteStdinToolUseMessage",
        Row::Write { .. } => "WriteToolUseMessage",
        _ => panic!("unexpected Claude tool row: {row:?}"),
    };
    let fields = garcon_js::json::from_slice(&serde_json::to_vec(row).unwrap()).unwrap();
    markers::instance(class, fields)
}

#[test]
fn recorded_claude_tool_use_matches() {
    let stats = replay_with_options(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/tool-use-converter"
        ),
        ReplayOptions {
            result_order_exceptions: &[ResultOrderException {
                function: "convertClaudeToolUse",
                path: "$.result.fields.questions[*]",
                reason: QUESTION_ORDER,
            }],
            ..Default::default()
        },
        |function, args| {
            if function != "convertClaudeToolUse" {
                return Err(CaseError::unhandled(function));
            }
            let timestamp = text(function, args.first())?.expect("recorded timestamp");
            let part = unknown(function, args.get(1))?;
            Ok(encode(&convert_claude_tool_use(timestamp, &part)))
        },
    );
    assert_eq!(stats.known_differences, 2);
}

#[test]
fn recorded_claude_permission_requests_match() {
    replay_with_options(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/permission-tool-converter"
        ),
        ReplayOptions {
            result_order_exceptions: &[ResultOrderException {
                function: "convertClaudePermissionRequest",
                path: "$.result.requestedTool.fields.questions[*]",
                reason: QUESTION_ORDER,
            }],
            ..Default::default()
        },
        |function, args| {
            if function != "convertClaudePermissionRequest" {
                return Err(CaseError::unhandled(function));
            }
            let timestamp = text(function, args.first())?.expect("recorded timestamp");
            let id = text(function, args.get(1))?.expect("recorded occurrence id");
            let request = unknown(function, args.get(2))?;
            let permission = convert_claude_permission_request(timestamp, id, &request);
            let AgentRequestedPermission::Requested {
                ref requested_tool, ..
            } = permission;
            let mut output: Value =
                garcon_js::json::from_slice(&serde_json::to_vec(&permission).unwrap()).unwrap();
            output["requestedTool"] = encode(requested_tool);
            Ok(output)
        },
    );
}
