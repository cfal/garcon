use garcon_agent_codex::service_tier::{
    assert_effective_tier, codex_service_tier, codex_speed, normalize_codex_service_tier,
};
use garcon_cases::{CaseError, replay, text, unknown};
use garcon_interface::errors::AgentIntegrationError;
use serde_json::{Value, json};

fn error_result(error: AgentIntegrationError) -> Value {
    let mut properties = json!({"code":error.code.as_str(),"retryable":error.retryable});
    if let Some(details) = error.details {
        properties["details"] = details.into_value();
    }
    json!({
        "$":"error", "name":"AgentIntegrationError", "message":error.message,
        "properties":properties,
    })
}

#[test]
fn codex_speed_settings_match_recorded_cases() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/service-tier"),
        |function, args| {
            Ok(match function {
                "codexSpeed" => {
                    let settings =
                        serde_json::from_value(unknown(function, args.first())?.into_owned())
                            .unwrap();
                    codex_speed(&settings).map_or_else(error_result, |value| json!(value))
                }
                "codexServiceTier" => {
                    let speed = args
                        .first()
                        .map(|value| serde_json::from_value(value.clone()).unwrap());
                    json!(codex_service_tier(speed))
                }
                "normalizeCodexServiceTier" => {
                    json!(normalize_codex_service_tier(
                        args.first().and_then(Value::as_str)
                    ))
                }
                "assertEffectiveTier" => {
                    let requested = serde_json::from_value(args[0].clone()).unwrap();
                    let effective = args.get(1).and_then(Value::as_str);
                    let model = text(function, args.get(2))?.expect("recorded model");
                    assert_effective_tier(requested, effective, model)
                        .map_or_else(error_result, |()| json!({"$":"undefined"}))
                }
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}
