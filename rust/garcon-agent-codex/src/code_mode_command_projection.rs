use garcon_contract::chat_types::ToolUseChatMessage;
use garcon_js::number_to_string;
use indexmap::IndexMap;

pub use crate::code_mode_command_parser::{
    CodexCodeModeCommandProjection, project_codex_code_mode_commands,
};

const MAX_PENDING_CODE_MODE_CALLS: usize = 10_000;

pub fn codex_code_mode_bash_tool_id(outer_call_id: &str, command_index: f64) -> String {
    format!(
        "codex-code-mode:{outer_call_id}:{}",
        number_to_string(command_index)
    )
}

pub fn codex_code_mode_result_tool_id(
    outer_call_id: &str,
    projection: &CodexCodeModeCommandProjection,
) -> String {
    codex_code_mode_bash_tool_id(outer_call_id, projection.commands.len() as f64 - 1.0)
}

pub fn create_codex_code_mode_bash_messages(
    timestamp: &str,
    outer_call_id: &str,
    projection: &CodexCodeModeCommandProjection,
) -> Vec<ToolUseChatMessage> {
    projection
        .commands
        .iter()
        .enumerate()
        .map(|(index, command)| ToolUseChatMessage::Bash {
            timestamp: timestamp.to_owned(),
            tool_id: codex_code_mode_bash_tool_id(outer_call_id, index as f64),
            command: command.clone(),
            description: None,
        })
        .collect()
}

pub fn remember_codex_code_mode_result(
    result_tool_ids: &mut IndexMap<String, String>,
    outer_call_id: String,
    result_tool_id: String,
) {
    result_tool_ids.insert(outer_call_id, result_tool_id);
    if result_tool_ids.len() > MAX_PENDING_CODE_MODE_CALLS
        && result_tool_ids
            .first()
            .is_some_and(|(key, _)| !key.is_empty())
    {
        result_tool_ids.shift_remove_index(0);
    }
}

pub fn rewrite_codex_code_mode_command_prefix(commands: &[String]) -> String {
    let calls = commands
        .iter()
        .map(|command| {
            // INFALLIBLE: Serialization of a Rust string to JSON cannot fail.
            let quoted = serde_json::to_string(command).expect("serialize a command string");
            format!("  tools.exec_command({{ cmd: {quoted} }})")
        })
        .collect::<Vec<_>>()
        .join(",\n");
    format!(
        "const results = await Promise.all([\n{calls}\n]);\nfor (const result of results) text(result.output);"
    )
}
