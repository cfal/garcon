use garcon_agent_claude::{
    cli_protocol::convert_cli_message_to_chat_messages,
    permission_tool_converter::convert_claude_permission_request,
    tool_use_converter::convert_claude_tool_use,
};
use garcon_cases::{
    CaseError, ReplayOptions, ResultOrderException, markers, replay_with_options, text, unknown,
};
use garcon_contract::chat_types::{ChatMessage, ToolUseChatMessage};
use garcon_interface::{
    native_message_source::get_native_message_revision_source, producer::AgentRequestedPermission,
};
use serde_json::{Value, json};

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
fn recorded_cli_stream_rows_and_native_sources_match() {
    replay_with_options(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/cli-stream"),
        ReplayOptions {
            result_order_exceptions: &[ResultOrderException {
                function: "convertCliStreamFrame",
                path: "$.result[*].message.fields.questions[*]",
                reason: QUESTION_ORDER,
            }],
            ..Default::default()
        },
        |function, args| {
            if function != "convertCliStreamFrame" {
                return Err(CaseError::unhandled(function));
            }
            let frame = unknown(function, args.first())?;
            let rows = convert_cli_message_to_chat_messages(&frame, "2026-01-01T00:00:00.000Z")
                .into_iter()
                .map(|row| {
                    let message = match &row.value {
                        ChatMessage::ToolUse(tool) => encode(tool),
                        message => {
                            let class = match message {
                                ChatMessage::Assistant(_) => "AssistantMessage",
                                ChatMessage::Thinking(_) => "ThinkingMessage",
                                ChatMessage::ToolResult(_) => "ToolResultMessage",
                                _ => panic!("unexpected Claude stream row: {message:?}"),
                            };
                            let fields =
                                garcon_js::json::from_slice(&serde_json::to_vec(message).unwrap())
                                    .unwrap();
                            markers::instance(class, fields)
                        }
                    };
                    let source: Value = garcon_js::json::from_slice(
                        &serde_json::to_vec(&get_native_message_revision_source(&row)).unwrap(),
                    )
                    .unwrap();
                    json!({"message":message, "source":source})
                })
                .collect();
            Ok(Value::Array(rows))
        },
    );
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
