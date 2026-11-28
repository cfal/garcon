use std::{future::ready, path::PathBuf};

use garcon_contract::chat_search::ChatSearchSnippetRole;

use crate::{rows::SearchMessageRowInput, schema::SearchSyncMode, worker_protocol::WorkerIdentity};

use super::*;

fn begin(view: &str) -> IndexerRequest {
    IndexerRequest::SyncBegin {
        mode: SearchSyncMode::Replace,
        chat_id: "0000000000000001".into(),
        transcript_view_id: view.into(),
        expected_after_ordinal: 0,
        target_through: 1,
    }
}

fn rows() -> IndexerRequest {
    IndexerRequest::SyncRows {
        frame_index: 0,
        advance_to: 1,
        rows: vec![HistoricalSearchMessageRow {
            ordinal: 1,
            row: SearchMessageRowInput {
                role: ChatSearchSnippetRole::Assistant,
                timestamp: None,
                body: "Synthetic row".into(),
            },
        }],
    }
}

#[tokio::test(start_paused = true)]
async fn reopening_during_a_yield_fences_both_ingest_and_stale_cleanup() {
    let root = PathBuf::from(std::env::var_os("HOME").unwrap()).join("tmp/interface");
    std::fs::create_dir_all(&root).unwrap();
    let directory = tempfile::Builder::new()
        .prefix("search-reopen-")
        .tempdir_in(root)
        .unwrap();
    let (send, _read) = mpsc::channel(1);
    let reply = Reply {
        identity: WorkerIdentity {
            epoch: 1,
            request_id: 4,
        },
        send,
    };

    for (test_name, cleanup) in [("rows", false), ("cleanup", true)] {
        let state = RefCell::new(Indexer::default());
        let old = directory.path().join(format!("{test_name}-old.sqlite"));
        let new = directory.path().join(format!("{test_name}-new.sqlite"));
        process(&state, 1, IndexerRequest::Open(old), &reply)
            .await
            .unwrap();
        if cleanup {
            process(&state, 2, begin("old"), &reply).await.unwrap();
            process(&state, 2, rows(), &reply).await.unwrap();
            process(&state, 2, IndexerRequest::SyncFinish, &reply)
                .await
                .unwrap();
        }
        assert!(
            matches!(process(&state, 4, begin("current"), &reply).await.unwrap(), IndexerEvent::SyncAccepted { current: false, stale_rows, .. } if stale_rows == cleanup)
        );

        state.borrow_mut().duty_debt = Duration::from_secs(10);
        let work = if cleanup {
            IndexerRequest::SyncCleanup
        } else {
            rows()
        };
        let mut suspended = std::pin::pin!(process(&state, 4, work, &reply));
        tokio::select! { biased;
            _ = &mut suspended => panic!("{test_name} did not reach its duty wait"),
            () = ready(()) => {},
        }
        process(&state, 5, IndexerRequest::Open(new), &reply)
            .await
            .unwrap();
        assert_eq!(
            suspended.await.unwrap_err().code,
            "INDEXER_UNAVAILABLE",
            "{test_name}"
        );
        assert!(state.borrow().syncs.is_empty());
        assert!(
            list_chat_states(state.borrow().db().unwrap())
                .unwrap()
                .is_empty()
        );
    }
}
