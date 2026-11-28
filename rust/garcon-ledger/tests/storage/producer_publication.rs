use std::{future::ready, path::Path, process::Command, time::Instant};

use garcon_contract::{
    chat_types::{AssistantMessage, ChatMessage},
    chat_view::TranscriptMessage,
};
use garcon_interface::producer::AgentProducedRow;
use garcon_ledger::{
    codec::StoredLedgerRow, contracts::transcript_view_id,
    garcon_command_publication::canonicalize_garcon_producer_rows,
    presentation::ledger_rows_to_transcript_messages,
};
use serde::Serialize;
use serde_json::json;

use super::bulk_views::{initialize, store};

const AT: &str = "2026-11-28T09:00:00.000Z";
const VIEW: &str = "publication-view";
const CHAT: &str = "producer";

async fn native(root: &Path, write: bool) -> String {
    let store = store(root);
    if write {
        initialize(&store, CHAT, VIEW, &[]);
        let message = |content: &str| {
            ChatMessage::Assistant(AssistantMessage {
                timestamp: AT.into(),
                content: content.into(),
                questions: None,
            })
        };
        let publication = canonicalize_garcon_producer_rows(vec![
            AgentProducedRow {
                message: message("<garcon-get-chat-id />\n\nSynthetic answer.\n<garcon-ticket-read ticket-id=\"G-1\" />"),
                provider_meta: Some(json!({"source":"synthetic"}).into()),
            },
            AgentProducedRow { message: message("<garcon-ticket-read />"), provider_meta: None },
        ]).unwrap();
        store
            .append(
                CHAT,
                &transcript_view_id(VIEW).unwrap(),
                &publication.drafts,
            )
            .unwrap();
        let batch = (0..2_000)
            .map(|_| AgentProducedRow {
                message: message("<garcon-get-chat-id />\nSynthetic answer."),
                provider_meta: None,
            })
            .collect();
        let start = Instant::now();
        let wide = canonicalize_garcon_producer_rows(batch).unwrap();
        let elapsed = start.elapsed();
        assert_eq!(wide.drafts.len(), 4_000);
        eprintln!(
            "Rust command canonicalization (2,000 rows): {:.2} ms",
            elapsed.as_secs_f64() * 1000.0
        );
    }
    let head = store.high_watermark(CHAT).unwrap();
    let stored = store
        .with_stored_rows_through(CHAT, &head, |rows| ready(Ok(rows)), None)
        .await
        .unwrap();
    let visible = ledger_rows_to_transcript_messages(CHAT, &store.current_rows(CHAT).unwrap());
    assert_eq!(stored.len(), 5);
    assert_eq!(
        visible
            .iter()
            .map(|entry| entry.ordinal.0)
            .collect::<Vec<_>>(),
        [1.0, 4.0, 5.0]
    );
    store.close().unwrap();
    #[derive(Serialize)]
    struct ObservedPublication {
        stored: Vec<StoredLedgerRow>,
        visible: Vec<TranscriptMessage>,
    }
    serde_json::to_string(&ObservedPublication { stored, visible }).unwrap()
}

fn bun(root: &Path, mode: &str) -> String {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/producer-publication-oracle.ts"
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
    eprint!("{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim_end().into()
}

#[tokio::test]
async fn command_evidence_stays_private_on_ledgers_written_by_either_runtime() {
    let original = tempfile::tempdir().unwrap();
    let expected = bun(original.path(), "write");
    assert_eq!(native(original.path(), false).await, expected);
    let port = tempfile::tempdir().unwrap();
    assert_eq!(native(port.path(), true).await, expected);
    assert_eq!(bun(port.path(), "read"), expected);
}
