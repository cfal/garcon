use std::{path::PathBuf, time::Duration};

use garcon_contract::chat_search::{
    ChatSearchResultMode, ChatSearchSnippetRole, TranscriptSearchAllowedChat,
    compile_chat_search_query,
};
use garcon_search::{
    indexer::indexer_slot,
    query::TranscriptSearchOrder,
    query_frames::search_frames,
    reader::{ReaderWorker, reader_slot},
    rows::{HistoricalSearchMessageRow, SearchMessageRowInput},
    schema::SearchSyncMode,
    worker_protocol::{
        IndexerEvent, IndexerRequest, ReaderEvent, ReaderFrame, ReaderRequest, ReaderSearch,
    },
    worker_supervisor::{Response, WorkerError},
};

const DEADLINE: Duration = Duration::from_secs(5);
const CHAT: &str = "0000000000000001";
const VIEW: &str = "synthetic-view";

fn complete<T>(_: &T) -> Response {
    Response::Complete
}

fn options() -> ReaderSearch {
    ReaderSearch {
        query: compile_chat_search_query("#731", None),
        order: TranscriptSearchOrder::Relevance,
        mode: ChatSearchResultMode::Page,
        offset: 0,
        limit: 20,
        snippet_limit: 2,
    }
}

fn allowed(chat_id: &str) -> TranscriptSearchAllowedChat {
    TranscriptSearchAllowedChat {
        chat_id: chat_id.into(),
        transcript_view_id: VIEW.into(),
        through_ordinal: 2,
    }
}

async fn query(worker: &ReaderWorker, chat: &str) -> Result<ReaderEvent, WorkerError> {
    let frames = search_frames(options(), vec![allowed(chat)]).unwrap();
    worker
        .request(
            frames.into_iter().map(ReaderRequest::Search),
            None,
            DEADLINE,
            complete,
        )
        .await
}

#[tokio::test]
async fn distinct_readers_keep_their_own_connection_and_ignore_unrelated_retirement() {
    let root = PathBuf::from(std::env::var_os("HOME").unwrap()).join("tmp/interface");
    std::fs::create_dir_all(&root).unwrap();
    let temp = tempfile::Builder::new()
        .prefix("search-workers-")
        .tempdir_in(&root)
        .unwrap();
    let path = temp.path().join("index.sqlite");
    let indexer = indexer_slot();
    assert_eq!(
        indexer.start(path.clone(), None, DEADLINE).await.unwrap(),
        IndexerEvent::Opened { recreated: true }
    );
    let writer = indexer.worker().unwrap();
    let make_begin = || IndexerRequest::SyncBegin {
        mode: SearchSyncMode::Replace,
        chat_id: CHAT.into(),
        transcript_view_id: VIEW.into(),
        expected_after_ordinal: 0,
        target_through: 2,
    };

    let session = writer.begin_session().unwrap();
    assert!(matches!(
        session
            .request([make_begin()], None, DEADLINE, complete)
            .await
            .unwrap(),
        IndexerEvent::SyncAccepted { current: false, .. }
    ));
    let wrong_frame = IndexerRequest::SyncRows {
        frame_index: 1,
        rows: Vec::new(),
        advance_to: 1,
    };
    assert_eq!(
        session
            .request([wrong_frame], None, DEADLINE, complete)
            .await
            .unwrap_err()
            .to_string(),
        "INVALID_INDEX_FRAME"
    );
    assert_eq!(
        session
            .request([IndexerRequest::SyncFinish], None, DEADLINE, complete)
            .await
            .unwrap_err()
            .to_string(),
        "INVALID_INDEX_REQUEST"
    );

    let session = writer.begin_session().unwrap();
    assert!(matches!(
        session
            .request([make_begin()], None, DEADLINE, complete)
            .await
            .unwrap(),
        IndexerEvent::SyncAccepted {
            indexed_through: 0,
            ..
        }
    ));
    let last = IndexerRequest::SyncRows {
        frame_index: 0,
        advance_to: 2,
        rows: vec![HistoricalSearchMessageRow {
            ordinal: 1,
            row: SearchMessageRowInput {
                role: ChatSearchSnippetRole::Assistant,
                timestamp: None,
                body: "Synthetic PR #731.".into(),
            },
        }],
    };
    assert_eq!(
        session
            .request([last], None, DEADLINE, complete)
            .await
            .unwrap(),
        IndexerEvent::SyncProgress {
            frame_index: 0,
            indexed_through: 2
        }
    );
    assert!(matches!(
        session
            .request([IndexerRequest::SyncFinish], None, DEADLINE, complete)
            .await
            .unwrap(),
        IndexerEvent::SyncComplete { .. }
    ));
    assert_eq!(
        writer
            .request(
                [IndexerRequest::MarkFailed {
                    chat_id: "noncanonical-id".into(),
                    transcript_view_id: VIEW.into(),
                    error_code: "SEARCH_SOURCE_FAILED".into(),
                }],
                None,
                DEADLINE,
                complete
            )
            .await
            .unwrap(),
        IndexerEvent::Ack
    );

    let first_slot = reader_slot();
    let second_slot = reader_slot();
    for reader in [&first_slot, &second_slot] {
        assert_eq!(
            reader.start(path.clone(), None, DEADLINE).await.unwrap(),
            ReaderEvent::Opened
        );
    }
    let first = first_slot.worker().unwrap();
    let second = second_slot.worker().unwrap();
    let invalid_sequence = [
        ReaderRequest::Search(ReaderFrame::SearchStart(options())),
        ReaderRequest::Search(ReaderFrame::SearchAllowlistChunk {
            chunk_index: 1,
            allowed_chats: vec![allowed(CHAT)],
            done: true,
        }),
    ];
    assert_eq!(
        first
            .request(invalid_sequence, None, DEADLINE, complete)
            .await
            .unwrap_err()
            .to_string(),
        "INVALID_SEARCH_FRAME"
    );
    assert!(first.available());
    assert_eq!(
        query(&first, "noncanonical-id").await,
        Err(WorkerError::InvalidMessage)
    );
    assert!(!first.available());
    assert!(second.available());
    let ReaderEvent::SearchResult(result) = query(&second, CHAT).await.unwrap() else {
        panic!("expected search result")
    };
    assert_eq!(result.index.indexed_chat_count, 1);
    assert_eq!(result.results[0].snippets[0].text, "Synthetic PR #731.");
    assert!(first_slot.worker().is_none());
    assert_eq!(
        first_slot.start(path, None, DEADLINE).await.unwrap(),
        ReaderEvent::Opened
    );
    let replacement = first_slot.worker().unwrap();
    assert_ne!(first.epoch(), replacement.epoch());
    assert!(matches!(
        query(&replacement, CHAT).await.unwrap(),
        ReaderEvent::SearchResult(_)
    ));
    first_slot.stop(DEADLINE).await.unwrap();
    second_slot.stop(DEADLINE).await.unwrap();
    indexer.stop(DEADLINE).await.unwrap();
}
