use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::{chat_search::ChatSearchSnippetRole, chat_types::parse_chat_message};
use garcon_search::{
    message_projector::project_search_message,
    query_latency_stats::{QueryLatencySample, QueryLatencyStats},
    rows::HistoricalSearchMessageRow,
};
use serde::Serialize;
use serde_json::{Value, json};

fn wire(value: impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(&value).unwrap()).unwrap()
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let value = unknown(function, args.first())?;
    match function {
        "projectSearchMessage" => {
            let message = parse_chat_message(&value)
                .ok()
                .flatten()
                .ok_or_else(|| CaseError::unhandled(function))?;
            Ok(wire(project_search_message(&message)))
        }
        "queryLatencySnapshot" => {
            let mut stats = QueryLatencyStats::default();
            for operation in value
                .as_array()
                .ok_or_else(|| CaseError::unhandled(function))?
            {
                match operation[0].as_str() {
                    Some("served") => {
                        let number = |index: usize| {
                            operation[index]
                                .as_f64()
                                .ok_or_else(|| CaseError::unhandled(function))
                        };
                        stats.record_served(QueryLatencySample {
                            admission_ms: number(1)?,
                            execution_ms: number(2)?,
                            total_ms: number(3)?,
                        });
                    }
                    Some("timed-out") => stats.record_timed_out(),
                    Some("busy") => stats.record_rejected_busy(),
                    _ => return Err(CaseError::unhandled(function)),
                }
            }
            Ok(wire(stats.snapshot()))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn search_leaves_match_bun() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/search-leaves"
        ),
        dispatch,
    );
    assert_eq!(stats.total, 182);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn indexes_referenced_output_before_long_progress_without_duplicating_it() {
    let message = parse_chat_message(&json!({
        "type":"tool-result", "timestamp":"synthetic", "toolId":"fixture", "isError":true,
        "content":{"items":[
            {"type":"text", "text":"Working ".repeat(800)},
            {"type":"content", "content":{"type":"text", "text":"Operation refused"}},
        ]},
        "primaryTextItems":[1],
    }))
    .unwrap()
    .unwrap();
    let row = project_search_message(&message).unwrap();
    assert_eq!(row.role, ChatSearchSnippetRole::Tool);
    assert!(row.body.starts_with("Operation refused"));
    assert_eq!(row.body.matches("Operation refused").count(), 1);
    assert!(garcon_js::utf16::len(&row.body) <= 2512);
}

#[test]
fn bounds_provider_timestamps_without_dropping_content() {
    let message = parse_chat_message(&json!({
        "type":"user-message", "timestamp":"\u{e9}".repeat(129), "content":"Synthetic content",
    }))
    .unwrap()
    .unwrap();
    let row = project_search_message(&message).unwrap();
    assert_eq!(
        serde_json::to_string(&HistoricalSearchMessageRow { ordinal: 37, row }).unwrap(),
        r#"{"ordinal":37,"role":"user","timestamp":null,"body":"Synthetic content"}"#,
    );
}

#[test]
fn rounds_durations_and_bounds_each_total_by_its_rounded_components() {
    let mut stats = QueryLatencyStats::default();
    stats.record_timed_out();
    stats.record_rejected_busy();
    stats.record_served(QueryLatencySample {
        admission_ms: 1.6,
        execution_ms: 2.6,
        total_ms: 4.2,
    });
    let result = stats.snapshot();
    assert_eq!(
        (result.served, result.timed_out, result.rejected_busy),
        (1, 1, 1)
    );
    assert_eq!(
        (result.admission_p50_ms, result.p50_ms, result.total_p50_ms),
        (2, 3, 5)
    );
}

#[test]
fn retains_only_the_latest_512_samples_without_resetting_the_served_counter() {
    let mut stats = QueryLatencyStats::default();
    stats.record_served(QueryLatencySample {
        admission_ms: 100_000.0,
        execution_ms: 100_000.0,
        total_ms: 200_000.0,
    });
    for value in 1..=512 {
        let elapsed = f64::from(value);
        stats.record_served(QueryLatencySample {
            admission_ms: elapsed,
            execution_ms: elapsed,
            total_ms: elapsed * 2.0,
        });
    }
    let result = stats.snapshot();
    assert_eq!(
        (result.served, result.p50_ms, result.p95_ms, result.max_ms),
        (513, 257, 487, 512)
    );
}
