use garcon_agent_codex::app_server::cli::assert_compatible_codex;
use garcon_cases::{CaseError, replay, text};
use serde_json::json;

#[test]
fn app_server_version_matches_the_cli_tests_and_boundary_inputs() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/app-server-version"
        ),
        |function, args| {
            if function != "assertCompatibleCodex" {
                return Err(CaseError::unhandled(function));
            }
            let user_agent = text(function, args.first())?.expect("recorded user agent");
            Ok(match assert_compatible_codex(user_agent) {
                Ok(()) => json!({"$":"undefined"}),
                Err(error) => json!({
                    "$":"error", "name":"Error", "message":error.to_string(), "properties":{},
                }),
            })
        },
    );
}
