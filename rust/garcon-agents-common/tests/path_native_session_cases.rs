use garcon_agents_common::native_session::path_native_session::PathNativeSessionCodec;
use garcon_cases::{CaseError, replay, round_tripped};
use garcon_interface::transcript::AgentNativeSessionRef;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn typed<T: DeserializeOwned>(function: &str, argument: Option<&Value>) -> Result<T, CaseError> {
    let json = round_tripped(function, argument)?
        .ok_or_else(|| CaseError::undeliverable("expected the original argument"))?;
    serde_json::from_value(json.into_owned())
        .map_err(|error| CaseError::undeliverable(error.to_string()))
}

#[test]
fn recorded_path_native_sessions_match() {
    let codec = PathNativeSessionCodec::new("synthetic-provider");
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/path-native-session"
        ),
        |function, args| match function {
            "encodePathNativeSession" => Ok(json!(codec.encode(typed(function, args.first())?))),
            "decodePathNativeSession" => {
                let reference: Option<AgentNativeSessionRef> = typed(function, args.first())?;
                if reference
                    .as_ref()
                    .is_some_and(|reference| !reference.value.is_object())
                {
                    return Err(CaseError::undeliverable(
                        "expected the original native session object",
                    ));
                }
                Ok(match codec.decode(reference.as_ref()) {
                    Ok(value) => json!({"ok": true, "value": value}),
                    Err(error) => {
                        json!({"ok": false, "code": error.code.as_str(), "message": error.message})
                    }
                })
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
