use garcon_agent_codex::app_server::command_display::normalize_codex_command_display;
use garcon_cases::{CaseError, replay, text};
use serde_json::json;

#[test]
fn recorded_command_display_matches() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/command-display"),
        |function, args| {
            if function != "normalizeCodexCommandDisplay" {
                return Err(CaseError::unhandled(function));
            }
            let command = text(function, args.first())?.expect("recorded command string");
            Ok(json!(normalize_codex_command_display(command)))
        },
    );
}
