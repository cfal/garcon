use garcon_base::stored_json::{MalformedStoredJsonError, parse_stored_json};
use garcon_cases::{CaseError, replay, text};
use serde_json::json;

#[test]
fn stored_json_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/stored-json"
        ),
        |function, args| {
            let required_text = |index| {
                text(function, args.get(index))?.ok_or_else(|| CaseError::unhandled(function))
            };
            match function {
                "parseStoredJson" => parse_stored_json(required_text(0)?, required_text(1)?)
                    .map(garcon_js::json::Opaque::into_value)
                    .map_err(|error| {
                        CaseError::new("MalformedStoredJsonError", error.to_string())
                            .with_property("subject", error.subject)
                    }),
                "new MalformedStoredJsonError" => {
                    let error = MalformedStoredJsonError {
                        subject: required_text(0)?.into(),
                    };
                    Ok(json!({
                        "$": "error",
                        "name": "MalformedStoredJsonError",
                        "message": error.to_string(),
                        "properties": {"subject": error.subject},
                    }))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_eq!(stats.with_wildcards, 0);
    assert_eq!(stats.passed, stats.total);
}
