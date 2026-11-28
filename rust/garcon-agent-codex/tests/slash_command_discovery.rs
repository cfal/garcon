use garcon_agent_codex::slash_command_discovery::parse_skills_list_response;
use garcon_cases::{CaseError, replay, unknown};
use serde_json::json;

#[test]
fn skills_list_response_matches_recorded_cases() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/slash-command-discovery"
        ),
        |function, args| {
            if function != "parseSkillsListResponse" {
                return Err(CaseError::unhandled(function));
            }
            let response = unknown(function, args.first())?;
            Ok(json!(parse_skills_list_response(&response)))
        },
    );
}
