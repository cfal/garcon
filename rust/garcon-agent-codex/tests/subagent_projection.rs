use garcon_agent_codex::{
    subagent_lifecycle::{
        convert_codex_inter_agent_lifecycle, convert_codex_subagent_activity,
        convert_codex_subagent_lifecycle_text,
    },
    subagent_tool_use::convert_codex_subagent_tool_use,
};
use garcon_cases::{CaseError, markers, replay, text, unknown};
use garcon_contract::chat_types::ToolUseChatMessage;
use serde_json::{Value, json};

fn encoded(row: Option<ToolUseChatMessage>) -> Value {
    match row.map(|row| json!(row)) {
        Some(Value::Object(fields)) => markers::instance("CodexSubagentToolUseMessage", fields),
        None => Value::Null,
        _ => panic!("expected serialized subagent tool message"),
    }
}

#[test]
fn recorded_subagent_tool_calls_match() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/subagent-tool-use"),
        |function, args| {
            if function != "convertCodexSubagentToolUse" {
                return Err(CaseError::unhandled(function));
            }
            let timestamp = text(function, args.first())?.unwrap();
            let tool_id = text(function, args.get(1))?.unwrap();
            let name = text(function, args.get(2))?.unwrap();
            let input = unknown(function, args.get(3))?;
            Ok(encoded(convert_codex_subagent_tool_use(
                timestamp, tool_id, name, &input,
            )))
        },
    );
}

#[test]
fn recorded_legacy_and_structured_subagent_lifecycle_match() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/subagent-lifecycle"
        ),
        |function, args| {
            let text_at = |index| text(function, args.get(index));
            let timestamp = text_at(0)?.unwrap();
            let tool_id = text_at(1)?.unwrap();
            Ok(encoded(match function {
                "convertCodexSubagentActivity" => Some(convert_codex_subagent_activity(
                    timestamp,
                    tool_id,
                    text_at(2)?.unwrap(),
                    text_at(3)?.unwrap(),
                    text_at(4)?.unwrap(),
                )),
                "convertCodexInterAgentLifecycle" => {
                    let author = unknown(function, args.get(2))?;
                    let recipient = unknown(function, args.get(3))?;
                    convert_codex_inter_agent_lifecycle(
                        timestamp,
                        tool_id,
                        &author,
                        &recipient,
                        text_at(4)?.unwrap(),
                    )
                }
                "convertCodexSubagentLifecycleText" => {
                    convert_codex_subagent_lifecycle_text(timestamp, tool_id, text_at(2)?.unwrap())
                }
                _ => return Err(CaseError::unhandled(function)),
            }))
        },
    );
}
