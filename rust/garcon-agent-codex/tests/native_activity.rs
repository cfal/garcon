use std::rc::Rc;

use garcon_agent_codex::native_activity::create_codex_native_activity_probe;
use garcon_agents_common::native_session::path_native_session::{
    PathNativeSessionCodec, PathNativeSessionValue,
};
use garcon_interface::native_history::{AgentNativeActivityProbe, AgentNativeActivityResult};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn native_activity_ignores_bookkeeping_but_does_not_invent_a_timestamp() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rollout.jsonl");
    let codecs = Rc::new(PathNativeSessionCodec::new("codex"));
    let reference = codecs
        .encode(PathNativeSessionValue {
            path: path.to_str().map(str::to_owned),
            agent_session_id: Some("synthetic-session".into()),
            model_endpoint_id: None,
        })
        .unwrap();
    let probe = create_codex_native_activity_probe(codecs).unwrap();
    let relevant = r#"{"type":"response_item","timestamp":"2026-08-12T00:00:01.000Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Synthetic answer."}]}}"#;
    let bookkeeping =
        r#"{"type":"turn_context","timestamp":"2026-08-12T00:00:02.000Z","payload":{}}"#;
    let undated =
        r#"{"type":"event_msg","payload":{"type":"user_message","message":"Synthetic prompt."}}"#;
    for (rows, missing_timestamp) in [
        (format!("{relevant}\n{bookkeeping}\n"), false),
        (format!("{relevant}\n{undated}\n{bookkeeping}\n"), true),
    ] {
        tokio::fs::write(&path, rows).await.unwrap();
        let native = probe
            .last_activity(reference.clone(), CancellationToken::new())
            .await
            .unwrap();
        if missing_timestamp {
            assert_eq!(native, AgentNativeActivityResult::Unavailable);
        } else {
            assert!(
                matches!(&native, AgentNativeActivityResult::Ready { value } if value.last_entry_at.as_deref() == Some("2026-08-12T00:00:01.000Z"))
            );
        }
        let oracle = tokio::process::Command::new("bun")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/oracles/native-activity.ts"
            ))
            .arg(&path)
            .output()
            .await
            .unwrap();
        assert!(
            oracle.status.success(),
            "{}",
            String::from_utf8_lossy(&oracle.stderr)
        );
        assert_eq!(serde_json::to_vec(&native).unwrap(), oracle.stdout);
    }
}
