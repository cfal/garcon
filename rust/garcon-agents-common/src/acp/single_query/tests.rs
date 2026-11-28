use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;

use garcon_base::errors::error_metadata;
use garcon_js::json::stringify;
use tokio::process::Command;
use tokio::task::LocalSet;
use tokio::time::timeout;

use super::*;
use crate::acp::protocol::garcon_initialize_params;
use crate::which::which;

const LIMIT: Duration = Duration::from_secs(15);
const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/acp-single-query-peer.ts"
);
const ORACLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/oracles/acp-single-query-wire.ts"
);

fn options(bun: &Path, mode: &str, capture: &Path) -> AcpSingleQueryOptions {
    AcpSingleQueryOptions {
        spawn: AcpSpawnSpec {
            command: bun.to_str().unwrap().to_owned(),
            args: vec![
                FIXTURE.to_owned(),
                mode.to_owned(),
                capture.to_str().unwrap().to_owned(),
            ],
            cwd: env!("CARGO_MANIFEST_DIR").to_owned(),
            env: Default::default(),
        },
        initialize: garcon_initialize_params(None).unwrap(),
        authenticate_method_id: None,
        prompt: "  request  ".to_owned(),
        signal: CancellationToken::new(),
        request_timeout_ms: Some(if mode == "timeout" { 750.0 } else { 5000.0 }),
        create_transport: None,
        configure: Some(Rc::new(|client, created| {
            Box::pin(async move {
                let id = created["sessionId"].as_str().unwrap();
                client.set_session_model(id, "sample-model").await?;
                Ok(())
            })
        })),
        respond_to_request: Some(Rc::new(|method| {
            (method == "sample/version").then(|| json!({"version": 1}))
        })),
        split_failure: Some(Rc::new(|chunk| match chunk.strip_prefix("\nFAIL: ") {
            Some(failure) => AcpSplitChunk {
                text: String::new(),
                failure: Some(failure.to_owned()),
            },
            None => AcpSplitChunk {
                text: chunk.to_owned(),
                failure: None,
            },
        })),
    }
}

async fn compare_original(mode: &str) {
    let bun = which(OsStr::new("bun")).expect("the pinned Bun is on PATH");
    let dir = tempfile::tempdir().unwrap();
    let original_file = dir.path().join("original.jsonl");
    let rust_file = dir.path().join("rust.jsonl");
    let original = timeout(
        LIMIT,
        Command::new(&bun)
            .args([ORACLE, mode])
            .arg(&original_file)
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .env_clear()
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("original query must finish")
    .unwrap();
    assert!(
        original.status.success(),
        "{}",
        String::from_utf8_lossy(&original.stderr)
    );
    let actual = match timeout(LIMIT, run_acp_single_query(options(&bun, mode, &rust_file)))
        .await
        .expect("Rust query must finish")
    {
        Ok(text) => json!({"text": text}),
        Err(error) => match error.downcast_ref::<AgentIntegrationError>() {
            Some(provider) => json!({
                "message": provider.message,
                "code": provider.code.as_str(),
                "retryable": provider.retryable,
            }),
            None => json!({"message": error.to_string()}),
        },
    };
    match mode {
        "quoted" => assert_eq!(
            actual,
            json!({"text": "hello\nFAIL: model unavailable world"})
        ),
        "failure" => assert_eq!(
            actual,
            json!({
                "message": "model unavailable", "code": "PROVIDER_FAILURE", "retryable": false,
            })
        ),
        "timeout" => assert_eq!(
            actual,
            json!({"message": "ACP request timed out after 750ms: session/prompt"})
        ),
        other => panic!("unknown query fixture mode {other}"),
    }
    assert_eq!(
        format!("{}\n", stringify(&actual)),
        String::from_utf8(original.stdout).unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(&rust_file).unwrap(),
        std::fs::read_to_string(&original_file).unwrap(),
    );
}

#[tokio::test]
async fn matches_bun_for_answer_requests_and_output_after_the_reply() {
    LocalSet::new().run_until(compare_original("quoted")).await;
}

#[tokio::test]
async fn matches_bun_for_the_final_in_band_error() {
    LocalSet::new().run_until(compare_original("failure")).await;
}

#[tokio::test]
async fn bounds_the_disposable_prompt_by_the_query_timeout() {
    LocalSet::new().run_until(compare_original("timeout")).await;
}

#[tokio::test]
async fn rejects_a_preaborted_query_without_spawning_a_process() {
    let mut options = options(Path::new("unused"), "quoted", Path::new("unused"));
    options.signal.cancel();
    options.create_transport = Some(Rc::new(|| {
        panic!("an aborted query must not spawn a process")
    }));
    let error = run_acp_single_query(options).await.unwrap_err();
    assert_eq!(error_metadata(error.as_ref()).name, "AbortError");
    assert_eq!(error.to_string(), "The operation was aborted.");
}
