use garcon_agent_pi::history_loader::load_pi_chat_messages;
use garcon_interface::native_message_source::get_native_message_revision_source;
use serde_json::json;
use tokio::{fs, process::Command};

#[tokio::test]
async fn applies_active_context_edits_without_losing_original_source_identities() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("context-edits.jsonl");
    let text = include_str!("fixtures/context-edits.jsonl");
    fs::write(&path, text).await.unwrap();
    let bad = directory.path().join("invalid.jsonl");
    fs::write(&bad, format!("{text}{{\"type\": false}}\n"))
        .await
        .unwrap();

    let oracle = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/history-loader.ts"
        ))
        .arg(&path)
        .arg(&bad)
        .output()
        .await
        .unwrap();
    assert!(
        oracle.status.success(),
        "{}",
        String::from_utf8_lossy(&oracle.stderr)
    );
    let rows = load_pi_chat_messages(path.to_str().unwrap()).await.unwrap();
    let invalid = load_pi_chat_messages(bad.to_str().unwrap())
        .await
        .unwrap_err();
    assert_eq!(invalid.to_string(), "Pi transcript record 8 is invalid");
    let actual = json!([
        { "rows": rows.into_iter().map(|row| json!({
            "message": row.value, "source": get_native_message_revision_source(&row),
        })).collect::<Vec<_>>() },
        { "error": invalid.to_string() },
    ]);
    assert_eq!(serde_json::to_vec(&actual).unwrap(), oracle.stdout);
}
