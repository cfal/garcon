//! Replays the recordings of the `common/` modules ported by the interface
//! session (ADR-020). `bun rust/parity/cli.ts unit record <module> --tests
//! <its tests> --inputs tests/inputs/common/<module>.jsonl --out
//! tests/cases/common/<module>` writes each recording, and every case must
//! match here.

// The readers this replay does not call are read by the crate's other replay.
#[expect(
    dead_code,
    reason = "shared readers; `recorded_cases.rs` calls the rest"
)]
mod support;

use garcon_cases::{CaseError, Stats, replay};
use garcon_contract::git_error::{GitServiceError, is_git_service_error_code};
use serde_json::{Value, json};

fn assert_all_match(module: &str, stats: Stats) {
    // A wildcard would let the port return anything for that case.
    assert_eq!(
        stats.with_wildcards, 0,
        "{module}: the recording has wildcards"
    );
    assert_eq!(stats.passed, stats.total, "{module}: recorded cases differ");
}

fn dispatch_git_error(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "isGitServiceErrorCode" => {
            let value = support::unknown(function, args.first())?;
            Ok(json!(is_git_service_error_code(&value).is_some()))
        }
        "new GitServiceError" => {
            let code = support::text(function, args.first())?;
            let message = support::text(function, args.get(1))?;
            match (code, message) {
                (Some(code), Some(message)) => match is_git_service_error_code(&json!(code)) {
                    Some(code) => {
                        let error = GitServiceError::new(code, message);
                        Err(CaseError::new("GitServiceError", error.message)
                            .with_property("code", code.as_str())
                            .with_property("status", error.status))
                    }
                    None => Err(CaseError::unhandled(function)),
                },
                _ => Err(CaseError::unhandled(function)),
            }
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn git_error_cases_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/git-error"),
        dispatch_git_error,
    );
    assert_all_match("common/git-error.ts", stats);
}
