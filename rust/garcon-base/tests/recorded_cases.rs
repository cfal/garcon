//! Replays the recordings of the `server/common/` modules ported in this crate
//! (ADR-020). `bun rust/parity/cli.ts unit record <module> --tests <its
//! tests> --inputs tests/inputs/server-common/<module>.jsonl --out
//! tests/cases/server-common/<module>` writes each recording, and every case
//! must match here.

use garcon_base::domain_error::transcript_unavailable_message;
use garcon_cases::{CaseError, Stats, replay};
use serde_json::{Value, json};

fn assert_all_match(module: &str, stats: Stats) {
    // A wildcard would let the port return anything for that case.
    assert_eq!(
        stats.with_wildcards, 0,
        "{module}: the recording has wildcards"
    );
    assert_eq!(stats.passed, stats.total, "{module}: recorded cases differ");
}

#[test]
fn domain_error_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/domain-error"
        ),
        |function, args| match function {
            "transcriptUnavailableMessage" => {
                let retryable = args
                    .first()
                    .and_then(Value::as_bool)
                    .ok_or_else(|| CaseError::unhandled(function))?;
                Ok(json!(transcript_unavailable_message(retryable)))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
    assert_all_match("server/common/domain-error.ts", stats);
}
