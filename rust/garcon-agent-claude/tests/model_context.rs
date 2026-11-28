use garcon_agent_claude::model_context::resolve_claude_model;
use garcon_cases::{CaseError, replay, text};
use serde_json::json;

#[test]
fn recorded_model_context_cases_match() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/model-context"),
        |function, args| {
            if function != "resolveClaudeModel" {
                return Err(CaseError::unhandled(function));
            }
            let model = text(function, args.first())?.expect("recorded model string");
            match resolve_claude_model(model) {
                Ok(context) => Ok(garcon_js::json::from_slice(
                    &serde_json::to_vec(&context).unwrap(),
                )
                .unwrap()),
                Err(error) => Ok(json!({
                    "$": "error",
                    "name": "AgentIntegrationError",
                    "message": error.message,
                    "properties": {
                        "code": error.code.as_str(),
                        "retryable": error.retryable,
                    },
                })),
            }
        },
    );
}
