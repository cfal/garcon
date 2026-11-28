use std::{os::unix::fs::PermissionsExt, rc::Rc};

use futures::FutureExt;
use garcon_agent_codex::app_server::{
    cli::{CodexCommandSource, ResolvedCodexCli},
    client::{CodexAppServerClient, CodexAppServerClientOptions},
    paginated_history_source::PaginatedCodexHistorySource,
};
use garcon_interface::{
    errors::AgentIntegrationError, native_message_source::get_native_message_revision_source,
};
use serde_json::{Value, json};
use tokio::{fs, process::Command, task::LocalSet};
use tokio_util::sync::CancellationToken;

const ORACLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/oracles");

#[tokio::test]
async fn pagination_and_rollout_evidence_match_bun_for_order_and_failures() {
    LocalSet::new().run_until(async {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let binary = root.join("fake-codex");
        let fixture = format!("{ORACLES}/paginated-history-fixture.ts").replace('\'', "'\\''");
        fs::write(&binary, format!("#!/bin/sh\nexec bun '{fixture}' \"$@\"\n")).await.unwrap();
        fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).await.unwrap();
        let rollout = root.join("rollout.jsonl");
        let evidence = [
            json!({"type":"AgentMessage","id":"first"}),
            json!({"type":"UserMessage","id":"requested","client_id":"synthetic-request","content":[{"type":"text","text":"Steered request."}]}),
            json!({"type":"AgentMessage","id":"last"}),
        ].into_iter().map(|item| format!("{}\n", json!({
            "type":"event_msg", "timestamp":"2026-01-02T03:04:05.000Z",
            "payload":{"type":"item_completed","turn_id":"turn","item":item}
        }))).collect::<String>();
        fs::write(&rollout, evidence).await.unwrap();
        for mode in ["valid", "ambiguous", "repeated-cursor"] {
            let expected_trace = root.join(format!("{mode}.original.jsonl"));
            let actual_trace = root.join(format!("{mode}.rust.jsonl"));
            let oracle = Command::new("bun")
                .arg(format!("{ORACLES}/paginated-history.ts"))
                .arg(&binary).arg(&expected_trace).arg(mode).arg(&rollout)
                .output().await.unwrap();
            assert!(oracle.status.success(), "{}", String::from_utf8_lossy(&oracle.stderr));
            let create_client = {
                let binary = binary.to_str().unwrap().to_owned();
                let trace = actual_trace.to_str().unwrap().to_owned();
                Rc::new(move || {
                    let binary = binary.clone();
                    let mut options = CodexAppServerClientOptions::new(Rc::new(move |_| {
                        let command = binary.clone();
                        async move { Ok(ResolvedCodexCli { command, source: CodexCommandSource::Path }) }.boxed_local()
                    }));
                    options.env.insert("SYNTHETIC_CODEX_TRACE".into(), trace.clone());
                    options.env.insert("SYNTHETIC_CODEX_MODE".into(), mode.into());
                    CodexAppServerClient::new(options)
                })
            };
            let source = PaginatedCodexHistorySource {
                native_path: rollout.to_str().unwrap().into(), thread_id: "thread".into(),
                created_at: "2026-01-01T00:00:00.000Z".into(),
                create_client,
            };
            let loaded = source.load(&CancellationToken::new()).await;
            let actual = match loaded {
                Ok(messages) => {
                    let messages = messages.iter().map(|message| json!({
                        "message":message.value, "source":get_native_message_revision_source(message),
                    })).collect::<Vec<_>>();
                    assert_eq!(mode, "valid");
                    assert_eq!(messages[1]["message"]["metadata"]["upstreamRequestId"], "synthetic-request");
                    json!({"messages":messages})
                }
                Err(error) => {
                    assert_ne!(mode, "valid", "{error}");
                    let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
                    json!({"error":error.to_string(),"code":error.code.as_str(),"retryable":error.retryable,"details":error.details})
                }
            };
            let expected: Value = garcon_js::json::from_slice(&oracle.stdout).unwrap();
            assert_eq!(actual, expected, "{mode}");
            assert_eq!(serde_json::to_vec(&actual).unwrap(), oracle.stdout, "{mode}");
            let trace = |trace: String| {
                trace.lines().map(|line| garcon_js::json::from_str::<Value>(line).unwrap())
                    .filter(|row| matches!(row["method"].as_str(), Some("thread/items/list" | "thread/turns/list")))
                    .collect::<Vec<_>>()
            };
            assert_eq!(trace(fs::read_to_string(actual_trace).await.unwrap()), trace(fs::read_to_string(expected_trace).await.unwrap()), "{mode}");
        }
    }).await;
}
