use std::{collections::HashSet, fs, path::Path, process::Command, time::Duration};

use garcon_contract::{
    chat_activity::ChatRunOutcome,
    chat_types::{ChatMessage, parse_chat_message},
};
use garcon_ledger::{
    contracts::{LedgerRowData, LedgerRowDraft, RunOrigin, RunOutcome, transcript_view_id},
    errors::{LedgerError, safe_fence_diagnostic},
    input_submission::input_detail,
    service::{TranscriptLedgerService, TranscriptLedgerServiceOptions},
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::bulk_views::{initialize, store};

const AT: &str = "2026-11-28T09:00:00.000Z";
const VIEW: &str = "activity-view";
const CHATS: &[&str] = &[
    "finished",
    "failed",
    "interrupted",
    "input",
    "provider-input",
    "empty",
];

fn terminal(outcome: RunOutcome) -> LedgerRowDraft {
    LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data: LedgerRowData::RunEnded {
            outcome,
            origin: RunOrigin::Provider,
            error: None,
        },
    }
}

fn synthetic_user() -> ChatMessage {
    message("user-message", "Synthetic input")
}

fn message(kind: &str, content: &str) -> ChatMessage {
    parse_chat_message(&json!({"type": kind, "timestamp": AT, "content": content}))
        .unwrap()
        .unwrap()
}

fn provider(message: ChatMessage) -> LedgerRowDraft {
    LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data: LedgerRowData::ProviderRow { message },
    }
}

fn bun(root: &Path, mode: &str) -> Value {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/startup-oracle.ts"
        ))
        .arg(mode)
        .arg(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    garcon_js::json::from_slice(&output.stdout).unwrap()
}

async fn native(root: &Path, write: bool) -> Value {
    let store = store(root);
    let ledger =
        TranscriptLedgerService::new(store.clone(), TranscriptLedgerServiceOptions::default());
    if write {
        for &id in CHATS {
            let mut rows = match id {
                "finished" => vec![terminal(RunOutcome::Finished)],
                "failed" => vec![terminal(RunOutcome::Failed)],
                "interrupted" => vec![terminal(RunOutcome::Interrupted)],
                "provider-input" => vec![terminal(RunOutcome::Failed), provider(synthetic_user())],
                "input" => {
                    let ChatMessage::User(user) = synthetic_user() else {
                        unreachable!()
                    };
                    vec![
                        terminal(RunOutcome::Failed),
                        LedgerRowDraft {
                            at: AT.into(),
                            provider_meta: None,
                            data: LedgerRowData::UserInput {
                                detail: input_detail(user, vec![], None, false),
                            },
                        },
                    ]
                }
                _ => vec![],
            };
            if id != "empty" {
                rows.push(provider(message("assistant-message", "Synthetic suffix")));
            }
            initialize(&store, id, VIEW, &rows);
        }
        initialize(&store, "broken", VIEW, &[terminal(RunOutcome::Failed)]);
        let db = Connection::open(root.join("broken/ledger.sqlite")).unwrap();
        db.execute(
            "UPDATE transcript_rows SET payload_json = ?",
            [r#"{"value":?}"#],
        )
        .unwrap();
    }
    initialize(&store, "orphan", VIEW, &[]);
    fs::write(root.join("orphan-file"), "unrelated").unwrap();
    fs::create_dir_all(root.join(".trash/interrupted-delete")).unwrap();
    let registered = CHATS
        .iter()
        .copied()
        .chain(["broken"])
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    let removed = store
        .remove_unregistered_chat_directories(Some(&registered))
        .await
        .unwrap();
    assert!(!root.join("orphan").exists());
    let mut outcomes = Vec::new();
    for id in CHATS {
        outcomes.push(ledger.last_run_outcome(id, VIEW).await.unwrap());
    }
    let failure = ledger.last_run_outcome("broken", VIEW).await.unwrap_err();
    let fence = safe_fence_diagnostic(failure.as_ref());
    store.close().unwrap();
    json!({"removed": removed, "remaining": root.join("orphan-file").exists(), "outcomes": outcomes, "fence": fence})
}

#[tokio::test]
async fn startup_cleanup_and_outcomes_match_bun_ledgers_in_both_directions() {
    let original = tempfile::tempdir().unwrap();
    let expected = bun(original.path(), "write");
    assert_eq!(
        expected,
        json!({"removed": ["orphan"], "remaining": true,
        "outcomes": ["finished", "failed", "interrupted", null, null, null],
        "fence": {"causeName": "Error", "causeCode": "UNDECODABLE_LEDGER_ROW"}})
    );
    assert_eq!(native(original.path(), false).await, expected);
    let port = tempfile::tempdir().unwrap();
    assert_eq!(native(port.path(), true).await, expected);
    assert_eq!(bun(port.path(), "read"), expected);
}

#[tokio::test]
async fn missing_registry_authority_refuses_even_trash_only_and_never_deletes() {
    let temp = tempfile::tempdir().unwrap();
    let store = store(temp.path());
    assert_eq!(
        store
            .remove_unregistered_chat_directories(None)
            .await
            .unwrap(),
        Vec::<String>::new()
    );
    let interrupted = temp.path().join(".trash/interrupted");
    fs::create_dir_all(&interrupted).unwrap();
    let error = store
        .remove_unregistered_chat_directories(None)
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Missing chats.json with existing transcript ledgers; restore the registry before starting Garcon"
    );
    assert!(interrupted.is_dir());
    store
        .remove_unregistered_chat_directories(Some(&HashSet::new()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while interrupted.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(temp.path().join(".trash").is_dir());
}

#[cfg(unix)]
#[tokio::test]
async fn orphan_and_trash_symlinks_never_delete_their_targets() {
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("keep"), "outside").unwrap();
    let store = store(temp.path());
    std::os::unix::fs::symlink(outside.path(), temp.path().join("orphan-link")).unwrap();
    std::os::unix::fs::symlink(outside.path(), temp.path().join(".trash")).unwrap();
    initialize(&store, "orphan-dir", VIEW, &[]);
    let mut removed = store
        .remove_unregistered_chat_directories(Some(&HashSet::new()))
        .await
        .unwrap();
    removed.sort();
    assert_eq!(removed, ["orphan-dir", "orphan-link"]);
    assert!(
        fs::symlink_metadata(temp.path().join(".trash"))
            .unwrap()
            .is_dir()
    );
    assert!(fs::symlink_metadata(temp.path().join("orphan-link")).is_err());
    assert!(outside.path().join("keep").is_file());
}

#[tokio::test]
async fn deep_activity_payloads_and_recursive_parse_failures_preserve_fence_policy() {
    let temp = tempfile::tempdir().unwrap();
    let store = store(temp.path());
    let view = transcript_view_id(VIEW).unwrap();
    let set_payload = |chat_id: &str, raw: &str| {
        let db = Connection::open(temp.path().join(chat_id).join("ledger.sqlite")).unwrap();
        db.execute(
            "UPDATE transcript_rows SET payload_json = ? WHERE ordinal = 2",
            [raw],
        )
        .unwrap();
    };
    let deep = format!("{}\"leaf\"{}", "[".repeat(1100), "]".repeat(1100));
    for (id, row, value, expected) in [
        (
            "deep-tool",
            provider(message("assistant-message", "x")),
            r#"{"type":"assistant-message"}"#,
            Some(ChatRunOutcome::Failed),
        ),
        (
            "deep-input",
            provider(synthetic_user()),
            r#"{"type":"user-message"}"#,
            None,
        ),
        (
            "deep-terminal",
            terminal(RunOutcome::Finished),
            r#"{"outcome":"finished"}"#,
            Some(ChatRunOutcome::Finished),
        ),
    ] {
        initialize(&store, id, VIEW, &[terminal(RunOutcome::Failed), row]);
        set_payload(id, &format!(r#"{{"providerMeta":{deep},"value":{value}}}"#));
        assert_eq!(
            store.last_run_outcome(id, &view).await.unwrap(),
            expected,
            "{id}"
        );
    }
    initialize(
        &store,
        "broken",
        VIEW,
        &[terminal(RunOutcome::Finished), provider(synthetic_user())],
    );
    set_payload(
        "broken",
        r#"{"providerMeta":?,"value":{"type":"user-message"}}"#,
    );
    let error = store.last_run_outcome("broken", &view).await.unwrap_err();
    assert_eq!(
        safe_fence_diagnostic(error.as_ref()).cause_code,
        "UNDECODABLE_LEDGER_ROW"
    );
    assert!(matches!(
        store.current_view("broken").unwrap_err().downcast_ref(),
        Some(LedgerError::Fenced { .. })
    ));
    assert!(
        store
            .append("broken", &view, &[terminal(RunOutcome::Finished)])
            .is_err()
    );
    assert_eq!(
        store
            .last_run_outcome("deep-terminal", &view)
            .await
            .unwrap(),
        Some(ChatRunOutcome::Finished)
    );
}

#[tokio::test]
async fn secondary_schema_failure_does_not_fence_the_primary_or_materialize_a_missing_chat() {
    let temp = tempfile::tempdir().unwrap();
    let store = store(temp.path());
    let view = transcript_view_id(VIEW).unwrap();
    let missing = store.last_run_outcome("missing", &view).await.unwrap_err();
    assert!(matches!(
        missing.downcast_ref(),
        Some(LedgerError::ViewNotInitialized { .. })
    ));
    assert!(!temp.path().join("missing").exists());
    initialize(&store, "chat", VIEW, &[terminal(RunOutcome::Finished)]);
    let db = Connection::open(temp.path().join("chat/ledger.sqlite")).unwrap();
    db.execute(
        "ALTER TABLE transcript_rows RENAME TO renamed_rows",
        params![],
    )
    .unwrap();
    let error = store.last_run_outcome("chat", &view).await.unwrap_err();
    let error = error
        .downcast_ref::<garcon_base::errors::NamedError>()
        .unwrap();
    assert_eq!(error.name, "Error");
    assert_eq!(error.code.as_deref(), Some("SQLITE_ERROR"));
    assert_eq!(store.current_view("chat").unwrap().unwrap().view_id, view);
    db.execute(
        "ALTER TABLE renamed_rows RENAME TO transcript_rows",
        params![],
    )
    .unwrap();
    store
        .append("chat", &view, &[terminal(RunOutcome::Interrupted)])
        .unwrap();
    assert_eq!(
        store.last_run_outcome("chat", &view).await.unwrap(),
        Some(ChatRunOutcome::Interrupted)
    );
}
