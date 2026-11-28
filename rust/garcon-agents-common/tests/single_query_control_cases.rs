//! Replays the original's single-query control cases.

use std::error::Error;
use std::time::Duration;

use garcon_agents_common::shared::single_query_control::{
    SingleQueryControlOptions, single_query_runtime_options, with_single_query_control,
};
use garcon_cases::{
    CaseError, ReplayOptions, ResultOrderException, replay_with_options, round_tripped,
};
use garcon_interface::services::AgentSingleQueryRequest;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

fn undeliverable(error: impl std::fmt::Display) -> CaseError {
    CaseError::undeliverable(error.to_string())
}

fn typed<T: DeserializeOwned>(function: &str, value: Option<&Value>) -> Result<T, CaseError> {
    let value = round_tripped(function, value)?
        .ok_or_else(|| undeliverable("expected the original typed argument"))?;
    serde_json::from_value(value.into_owned()).map_err(undeliverable)
}

// A value as it crosses the JSON boundary, where object keys follow JavaScript's order.
fn wire(value: impl Serialize) -> Result<Value, CaseError> {
    let bytes = serde_json::to_vec(&value).map_err(undeliverable)?;
    garcon_js::json::from_slice(&bytes).map_err(undeliverable)
}

#[test]
fn recorded_single_query_control_matches() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .start_paused(true)
        .build()
        .unwrap();
    let stats = replay_with_options(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/single-query-control"
        ),
        ReplayOptions {
            result_order_exceptions: &[ResultOrderException {
                function: "runtimeOptions",
                path: "$.result",
                reason: "in-process options object, never serialized; a settings key named signal keeps its position in the original",
            }],
            ..Default::default()
        },
        |function, args| match function {
            "runtimeOptions" => {
                let request: AgentSingleQueryRequest = typed(function, args.first())?;
                let options = single_query_runtime_options(&request);
                assert!(!options.values.contains_key("signal"));
                options.signal.cancel();
                let mut recorded = Map::new();
                for (key, value) in &options.values {
                    recorded.insert(key.clone(), wire(value)?);
                }
                recorded.insert(
                    "signal".to_owned(),
                    json!(if request.signal.is_cancelled() {
                        "the request signal"
                    } else {
                        "another signal"
                    }),
                );
                Ok(Value::Object(recorded))
            }
            "timeoutAfter" => {
                let timeout_ms = round_tripped(function, args.first())?;
                let outcome = runtime.block_on(with_single_query_control(
                    SingleQueryControlOptions {
                        signal: None,
                        timeout_ms: timeout_ms.as_deref(),
                    },
                    |_| async {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        Ok::<_, Box<dyn Error>>("operation")
                    },
                ));
                Ok(json!(match outcome {
                    Ok(operation) => operation.to_owned(),
                    Err(error) => error.to_string(),
                }))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
