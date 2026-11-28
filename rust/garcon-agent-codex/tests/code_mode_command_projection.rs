use garcon_agent_codex::code_mode_command_projection::{
    CodexCodeModeCommandProjection, codex_code_mode_bash_tool_id, codex_code_mode_result_tool_id,
    create_codex_code_mode_bash_messages, project_codex_code_mode_commands,
    remember_codex_code_mode_result, rewrite_codex_code_mode_command_prefix,
};
use garcon_cases::{CaseError, javascript_number, replay, text, unknown};
use indexmap::IndexMap;
use serde_json::{Value, json};

fn commands(name: &str, arg: Option<&Value>) -> Result<Vec<String>, CaseError> {
    let raw = unknown(name, arg)?;
    Ok(raw
        .as_array()
        .expect("recorded commands")
        .iter()
        .map(|value| value.as_str().expect("recorded command").to_owned())
        .collect())
}

#[test]
fn code_mode_bash_messages_match_recordings() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/code-mode-command-projection"
        ),
        |name, args| {
            Ok(match name {
                "codexCodeModeBashToolId" => {
                    let id = text(name, args.first())?.expect("recorded call ID");
                    let index = javascript_number(name, args.get(1))?;
                    json!(codex_code_mode_bash_tool_id(id, index))
                }
                "rewriteCodexCodeModeCommandPrefix" => {
                    json!(rewrite_codex_code_mode_command_prefix(&commands(
                        name,
                        args.first()
                    )?))
                }
                "projectBashMessages" => {
                    let timestamp = text(name, args.first())?.expect("recorded timestamp");
                    let id = text(name, args.get(1))?.expect("recorded call ID");
                    let projection = CodexCodeModeCommandProjection {
                        commands: commands(name, args.get(2))?,
                    };
                    json!({
                        "messages": create_codex_code_mode_bash_messages(timestamp, id, &projection),
                        "resultId": codex_code_mode_result_tool_id(id, &projection),
                    })
                }
                _ => return Err(CaseError::unhandled(name)),
            })
        },
    );
}

#[test]
fn bounds_pending_result_associations() {
    let mut result_tool_ids = IndexMap::new();
    for index in 0..=10_000 {
        remember_codex_code_mode_result(
            &mut result_tool_ids,
            format!("outer-{index}"),
            format!("result-{index}"),
        );
    }
    assert_eq!(result_tool_ids.len(), 10_000);
    assert!(!result_tool_ids.contains_key("outer-0"));
    assert_eq!(result_tool_ids["outer-10000"], "result-10000");
}

#[test]
fn rewrites_a_round_trippable_canonical_program() {
    let projection = CodexCodeModeCommandProjection {
        commands: vec![
            "printf \"one;two\\n\"".into(),
            "printf \"\x24{literal} \x60ticks\x60 \\n\"".into(),
        ],
    };
    assert_eq!(
        project_codex_code_mode_commands(&rewrite_codex_code_mode_command_prefix(
            &projection.commands
        )),
        Some(projection)
    );
}
