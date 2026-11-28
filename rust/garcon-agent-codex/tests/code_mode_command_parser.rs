use garcon_agent_codex::code_mode_command_parser::project_codex_code_mode_commands;
use garcon_cases::{CaseError, replay, text};
use serde_json::json;

#[test]
fn code_mode_projection_matches_acorn() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/code-mode-command-parser"
        ),
        |function, args| {
            if function != "projectCodexCodeModeCommands" {
                return Err(CaseError::unhandled(function));
            }
            let source = text(function, args.first())?.expect("recorded program text");
            Ok(json!(project_codex_code_mode_commands(source)))
        },
    );
}
