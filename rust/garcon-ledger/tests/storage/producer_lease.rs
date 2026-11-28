use std::{cell::RefCell, future::ready, path::Path, process::Command, rc::Rc};

use garcon_base::errors::DiagnosticError;
use garcon_contract::chat_types::{AssistantMessage, ChatMessage};
use garcon_interface::producer::{AgentProducedRow, AgentProducerEvent};
use garcon_ledger::{
    codec::StoredLedgerRow,
    contracts::{LedgerRowData, LedgerRowDraft, TranscriptViewId, transcript_view_id},
    errors::TranscriptSinkClosedError,
    producer_lease::{ProducerClosedListener, ProducerLease},
    store::{TranscriptLedgerStore, TranscriptWatermark},
};
use serde::Serialize;

use super::bulk_views::{initialize, store};

const AT: &str = "2026-11-28T09:00:00.000Z";
const CHAT: &str = "lease";
const VIEW: &str = "lease-view";

fn row_event(content: &str) -> AgentProducerEvent {
    AgentProducerEvent::Rows {
        rows: vec![AgentProducedRow {
            message: ChatMessage::Assistant(AssistantMessage {
                timestamp: AT.into(),
                content: content.into(),
                questions: None,
            }),
            provider_meta: None,
        }],
    }
}

fn stored_lease(store: Rc<TranscriptLedgerStore>, view: TranscriptViewId) -> Rc<ProducerLease> {
    ProducerLease::new(
        move |_, event| {
            let AgentProducerEvent::Rows { rows } = event else {
                panic!("Expected only row events in this fixture");
            };
            let drafts = rows
                .into_iter()
                .map(|row| LedgerRowDraft {
                    at: AT.into(),
                    data: LedgerRowData::ProviderRow {
                        message: row.message,
                    },
                    provider_meta: row.provider_meta,
                })
                .collect::<Vec<_>>();
            store.append(CHAT, &view, &drafts)?;
            Ok(())
        },
        |_| Ok(()),
    )
}

async fn native_read(root: &Path, write: bool) -> String {
    let store = store(root);
    let lease = stored_lease(store.clone(), transcript_view_id(VIEW).unwrap());
    let old_sink = lease.sink();
    if write {
        initialize(&store, CHAT, VIEW, &[]);
        old_sink
            .publish(row_event("Synthetic accepted response"))
            .unwrap();
        assert_eq!(store.high_watermark(CHAT).unwrap().ordinal, 1);
    }
    lease.close().unwrap();
    let rejection = old_sink
        .publish(row_event("Synthetic retired response"))
        .unwrap_err()
        .downcast::<TranscriptSinkClosedError>()
        .unwrap();
    let head = store.high_watermark(CHAT).unwrap();
    let rows = store
        .with_stored_rows_through(CHAT, &head, |rows| ready(Ok(rows)), None)
        .await
        .unwrap();
    store.close().unwrap();
    #[derive(Serialize)]
    struct Report {
        head: TranscriptWatermark,
        rows: Vec<StoredLedgerRow>,
        rejection: Rejection,
    }
    #[derive(Serialize)]
    struct Rejection {
        name: String,
        message: String,
    }
    serde_json::to_string(&Report {
        head,
        rows,
        rejection: Rejection {
            name: rejection.diagnostic_metadata().name.into(),
            message: rejection.to_string(),
        },
    })
    .unwrap()
}

fn bun_read(root: &Path, mode: &str) -> String {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/producer-lease-oracle.ts"
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
    String::from_utf8(output.stdout).unwrap().trim_end().into()
}

// Lease-level evidence for TLV5-L03.01 and TLV5-L07.01.
#[tokio::test]
async fn decides_publish_and_close_by_synchronous_call_order_in_both_writers() {
    let original = tempfile::tempdir().unwrap();
    let expected = bun_read(original.path(), "write");
    assert_eq!(native_read(original.path(), false).await, expected);

    let native = tempfile::tempdir().unwrap();
    assert_eq!(native_read(native.path(), true).await, expected);
    assert_eq!(bun_read(native.path(), "read"), expected);
}

#[test]
fn close_marks_the_sink_closed_before_owner_cleanup_and_notifies_the_current_set_once() {
    let trace = Rc::new(RefCell::new(Vec::new()));
    let owner_trace = trace.clone();
    let lease = ProducerLease::new(
        |_, _| panic!("closed lease accepted publication"),
        move |lease| {
            assert!(lease.closed());
            owner_trace.borrow_mut().push("owner");
            lease.close()
        },
    );
    type Unsubscribe = Box<dyn Fn()>;
    let scheduled_removal = Rc::new(RefCell::new(None::<Unsubscribe>));
    let remove = scheduled_removal.clone();
    let first_trace = trace.clone();
    let first: Rc<ProducerClosedListener> = Rc::new(move || {
        first_trace.borrow_mut().push("first");
        if let Some(unsubscribe) = remove.borrow_mut().take() {
            unsubscribe();
        }
        Ok(())
    });
    let _remove_first = lease.on_closed(first.clone()).unwrap();
    let _duplicate = lease.on_closed(first).unwrap();

    let unwanted: Rc<ProducerClosedListener> =
        Rc::new(|| panic!("unsubscribed listener was called"));
    *scheduled_removal.borrow_mut() = Some(Box::new(lease.on_closed(unwanted).unwrap()));
    let last_trace = trace.clone();
    let _remove_last = lease
        .on_closed(Rc::new(move || {
            last_trace.borrow_mut().push("last");
            Ok(())
        }))
        .unwrap();
    lease.close().unwrap();
    lease.close().unwrap();
    let callback_trace = trace.clone();
    let _remove_after_close = lease
        .on_closed(Rc::new(move || {
            callback_trace.borrow_mut().push("after");
            Ok(())
        }))
        .unwrap();
    assert_eq!(*trace.borrow(), ["owner", "first", "last", "after"]);
}

#[test]
fn a_failing_close_listener_leaves_the_retired_sink_closed() {
    let lease = ProducerLease::new(
        |_, _| panic!("closed lease accepted publication"),
        |_| Ok(()),
    );
    let _unsubscribe = lease
        .on_closed(Rc::new(|| {
            Err(std::io::Error::other("synthetic close callback failure").into())
        }))
        .unwrap();
    let _unsubscribe_later = lease
        .on_closed(Rc::new(|| panic!("close continued after an error")))
        .unwrap();
    let error = lease.close().unwrap_err();
    assert!(error.is::<std::io::Error>());
    assert_eq!(error.to_string(), "synthetic close callback failure");
    lease.close().unwrap();
    assert!(
        lease
            .sink()
            .publish(row_event("Synthetic retired response"))
            .unwrap_err()
            .is::<TranscriptSinkClosedError>()
    );
}
