use garcon_agent_codex::jsonl_tool_use_converter::{
    ParsedApplyPatch, convert_codex_custom_tool_call, convert_codex_function_call,
    convert_codex_wait_function_call,
};
use garcon_cases::{
    CaseError, ReplayOptions, ResultOrderException, markers, replay, replay_with_options, text,
    unknown,
};
use garcon_contract::chat_types::ToolUseChatMessage;
use garcon_js::json::Opaque;
use serde_json::{Value, json};

fn encode(message: ToolUseChatMessage) -> Value {
    use ToolUseChatMessage as Tool;
    let class = match message {
        Tool::AskUserQuestion { .. } => "AskUserQuestionToolUseMessage",
        Tool::Bash { .. } => "BashToolUseMessage",
        Tool::CodexSubagent { .. } => "CodexSubagentToolUseMessage",
        Tool::Edit { .. } => "EditToolUseMessage",
        Tool::Exec { .. } => "ExecToolUseMessage",
        Tool::Unknown { .. } => "UnknownToolUseMessage",
        Tool::UpdatePlan { .. } => "UpdatePlanToolUseMessage",
        Tool::Wait { .. } => "WaitToolUseMessage",
        Tool::WriteStdin { .. } => "WriteStdinToolUseMessage",
        _ => panic!("unexpected Codex rollout tool"),
    };
    let Value::Object(fields) = json!(message) else {
        panic!("tool is not an object");
    };
    markers::instance(class, fields)
}

#[test]
fn rollout_function_calls_and_wait_arguments_match_the_original() {
    replay_with_options(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/jsonl-tool-use-converter"
        ),
        ReplayOptions {
            result_order_exceptions: &[ResultOrderException {
                function: "convertCodexFunctionCall",
                path: "$.result.fields.questions[*]",
                reason: "Codex creates question options last; the shared parser writes them before header",
            }],
            ..Default::default()
        },
        |function, args| {
            let timestamp = text(function, args.first())?.unwrap();
            Ok(match function {
                "convertCodexFunctionCall" => {
                    let payload = Opaque::from_value(unknown(function, args.get(1))?.into_owned());
                    encode(convert_codex_function_call(timestamp, &payload))
                }
                "convertCodexWaitFunctionCall" => {
                    let id = text(function, args.get(1))?.unwrap();
                    let raw = Opaque::from_value(unknown(function, args.get(2))?.into_owned());
                    convert_codex_wait_function_call(timestamp, id, Some(&raw))
                        .map_or(Value::Null, encode)
                }
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}

#[test]
fn rollout_custom_tool_calls_match_the_original() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/jsonl-custom-tool"),
        |function, args| {
            if function != "convertCodexCustomToolCall" {
                return Err(CaseError::unhandled(function));
            }
            let timestamp = text(function, args.first())?.unwrap();
            let payload = Opaque::from_value(unknown(function, args.get(1))?.into_owned());
            Ok(encode(convert_codex_custom_tool_call(
                timestamp,
                &payload,
                |input| ParsedApplyPatch {
                    file_path: "/fixture/file.js".into(),
                    old_string: input.into(),
                    new_string: "synthetic update".into(),
                },
            )))
        },
    );
}
