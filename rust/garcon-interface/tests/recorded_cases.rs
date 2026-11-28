use garcon_cases::{CaseError, replay, round_tripped, unknown};
use garcon_interface::errors::{
    AgentIntegrationError, is_agent_integration_error_code,
    is_unsupported_single_query_thinking_mode,
};
use serde_json::json;

#[test]
fn agent_integration_error_codes_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/interface/errors"),
        |function, args| {
            if function != "isAgentIntegrationErrorCode" {
                return Err(CaseError::unhandled(function));
            }
            let value = unknown(function, args.first())?;
            Ok(json!(is_agent_integration_error_code(&value).is_some()))
        },
    );
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn single_query_thinking_mode_errors_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/interface/single-query-thinking-mode"
        ),
        |function, args| {
            if function != "isUnsupportedSingleQueryThinkingMode" {
                return Err(CaseError::unhandled(function));
            }
            let code = args
                .first()
                .and_then(is_agent_integration_error_code)
                .ok_or_else(|| CaseError::unhandled(function))?;
            let details = match round_tripped(function, args.get(1))? {
                Some(details) => Some(
                    details
                        .as_object()
                        .cloned()
                        .ok_or_else(|| CaseError::unhandled(function))?,
                ),
                None => None,
            };
            let error = AgentIntegrationError::new(code, "synthetic", false, details);
            Ok(json!(is_unsupported_single_query_thinking_mode(&error)))
        },
    );
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}
