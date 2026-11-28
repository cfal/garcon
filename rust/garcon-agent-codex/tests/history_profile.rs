use std::cell::Cell;

use garcon_agent_codex::{
    app_server::runtime_support::NoopLogger,
    history_profile::{
        CodexSessionIdentityInput, inspect_codex_history_profile, inspect_codex_session_identity,
        inspect_codex_session_model_provider,
    },
    native_path::resolve_codex_native_path,
};
use garcon_base::errors::NamedError;
use garcon_interface::{errors::AgentIntegrationError, resources::ExecutorResult};
use serde::Serialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn outcome(result: ExecutorResult<impl Serialize>) -> Value {
    match result {
        Ok(value) => json!({"value":value}),
        Err(error) => {
            let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
            json!({"error":{
                "code":error.code.as_str(),"message":error.message,"retryable":error.retryable,
                "details": error.details
            }})
        }
    }
}

#[tokio::test]
async fn matches_bun_on_real_metadata_and_reconciles_only_missing_rollouts() {
    let directory = tempfile::tempdir().unwrap();
    let path = |name: &str| directory.path().join(name).to_str().unwrap().to_owned();
    let wire = |payload: Value| {
        format!(
            "{}\n",
            json!({"type":"session_meta","timestamp":"2026-07-20T00:00:00.000Z","payload":payload})
        )
    };
    let paginated = format!(
        " \n\n{}",
        wire(json!({
            "id":"thread",
            "timestamp":"2026-07-20T01:00:00.000Z",
            "model_provider":"synthetic-provider",
            "history_mode":"paginated",
            "history_base":{"thread_id":"inherited","end_ordinal_exclusive":2,"end_byte_offset":4096}
        }))
    );
    for (name, text) in [
        ("paginated", paginated),
        ("legacy", wire(json!({"id":"thread"}))),
        ("invalid", wire(json!({"id":"thread","model_provider":42}))),
        (
            "future",
            wire(json!({"id":"thread","history_mode":"future"})),
        ),
        ("mismatch", wire(json!({"id":"other-thread"}))),
        ("empty", String::new()),
        ("incomplete", "{".into()),
        (
            "oversized",
            wire(json!({"id":"thread","padding":"x".repeat(1024 * 1024)})),
        ),
    ] {
        tokio::fs::write(path(name), text).await.unwrap();
    }
    let signal = CancellationToken::new();
    let inspect = |native_path| CodexSessionIdentityInput {
        native_path,
        expected_thread_id: Some("thread"),
        signal: &signal,
    };
    let files = [
        "paginated",
        "legacy",
        "invalid",
        "future",
        "missing",
        "empty",
        "incomplete",
        "oversized",
    ]
    .map(path);
    let resolve = |stored, discovered: Result<&str, &'static str>| {
        let stored = path(stored);
        let discovered = discovered.map(path);
        let signal = signal.clone();
        async move {
            let calls = Cell::new(0);
            let result = resolve_codex_native_path(
                Some("thread"),
                Some(&stored),
                || {
                    calls.set(calls.get() + 1);
                    async move { discovered.map(Some).map_err(Into::into) }
                },
                &NoopLogger,
                &signal,
            )
            .await;
            json!({"value":outcome(result),"discoveryCalls":calls.get()})
        }
    };
    let mismatch = resolve("mismatch", Ok("paginated")).await;
    assert_eq!(mismatch["discoveryCalls"], 0);
    assert_eq!(
        mismatch["value"]["error"]["details"]["reason"],
        "thread-mismatch"
    );
    let actual = json!({
        "paginated":outcome(inspect_codex_history_profile(inspect(&files[0])).await),
        "savedProvider":outcome(inspect_codex_session_model_provider(inspect(&files[0])).await),
        "missingMode":outcome(inspect_codex_history_profile(inspect(&files[1])).await),
        "invalidProvider":outcome(inspect_codex_session_model_provider(inspect(&files[2])).await),
        "futureProfile":outcome(inspect_codex_history_profile(inspect(&files[3])).await),
        "futureIdentity":outcome(inspect_codex_session_identity(inspect(&files[3])).await),
        "missing":outcome(inspect_codex_session_identity(inspect(&files[4])).await),
        "empty":outcome(inspect_codex_session_identity(inspect(&files[5])).await),
        "incomplete":outcome(inspect_codex_session_identity(inspect(&files[6])).await),
        "oversized":outcome(inspect_codex_session_identity(inspect(&files[7])).await),
        "mismatch":mismatch,
        "stillMissing":resolve("missing", Ok("also-missing")).await,
        "moved":resolve("missing", Ok("paginated")).await,
        "corrupt":resolve("incomplete", Ok("paginated")).await,
        "discoveryError":resolve("missing", Err("synthetic discovery failure")).await,
    });
    let oracle = tokio::process::Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/history-profile.ts"
        ))
        .arg(directory.path())
        .output()
        .await
        .unwrap();
    assert!(
        oracle.status.success(),
        "{}",
        String::from_utf8_lossy(&oracle.stderr)
    );
    assert_eq!(
        serde_json::to_string(&actual).unwrap(),
        String::from_utf8(oracle.stdout).unwrap(),
    );
}

#[tokio::test]
async fn throws_abort_before_probing_a_native_path() {
    let signal = CancellationToken::new();
    signal.cancel();
    let error = resolve_codex_native_path(
        Some("thread"),
        Some("unused"),
        || async { panic!("cancelled lookup must not run discovery") },
        &NoopLogger,
        &signal,
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.downcast_ref::<NamedError>().unwrap().name,
        "AbortError"
    );
}
