use garcon_base::unavailable_service::unavailable_service;
use garcon_cases::{CaseError, markers, replay, text};
use serde_json::json;

#[test]
fn unavailable_service_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/unavailable-service"
        ),
        |function, args| {
            if function != "unavailableService" {
                return Err(CaseError::unhandled(function));
            }
            let service =
                text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
            let error = unavailable_service(service);
            Ok(json!({
                "$": "error",
                "name": "AgentCallError",
                "message": error.message,
                "properties": {
                    "code": error.code.as_str(),
                    "details": error.details.as_ref().map_or_else(markers::undefined, |details| details.as_value().clone()),
                    "retryable": error.retryable,
                    "outcome": error.outcome.as_str(),
                }
            }))
        },
    );
    assert_eq!(stats.with_wildcards, 0);
    assert_eq!(stats.passed, stats.total);
}
