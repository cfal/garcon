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

fn directory() -> tempfile::TempDir {
    let root = PathBuf::from(std::env::var_os("HOME").unwrap()).join("tmp/interface");
    std::fs::create_dir_all(&root).unwrap();
    tempfile::Builder::new()
        .prefix("search-workers-")
        .tempdir_in(&root)
        .unwrap()
}

#[tokio::test]
async fn distinct_readers_keep_their_own_connection_and_ignore_unrelated_retirement() {
    let temp = directory();
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

#[tokio::test]
async fn reader_searches_nul_and_boundary_normalized_surrogates_without_internal_failure() {
    use garcon_contract::chat_types::parse_chat_message;
    use garcon_js::clock::ManualClock;
    use garcon_search::{message_projector::project_search_message, schema::*};

    let temp = directory();
    let path = temp.path().join("nul.sqlite");
    let db = open_search_database(&path).unwrap().db;
    let clock = ManualClock::new(0);
    plan_chat_sync(
        &db,
        PlanChatSync {
            mode: SearchSyncMode::Replace,
            chat_id: CHAT,
            transcript_view_id: VIEW,
            expected_after_ordinal: 0,
            target_through: 1,
        },
        &clock,
    )
    .unwrap();
    let message = parse_chat_message(&serde_json::json!({ "type": "user-message", "timestamp": "", "content": "foo\0bar marker" }))
        .unwrap().unwrap();
    insert_rows_batch(
        &db,
        InsertRowsBatch {
            chat_id: CHAT,
            transcript_view_id: VIEW,
            advance_to: 1,
            rows: &[HistoricalSearchMessageRow {
                ordinal: 1,
                row: project_search_message(&message).unwrap(),
            }],
        },
        &clock,
    )
    .unwrap();
    finish_chat_sync(&db, CHAT, VIEW, &clock).unwrap();
    close_search_database(db).unwrap();

    let reader = reader_slot();
    reader.start(path, None, DEADLINE).await.unwrap();
    let worker = reader.worker().unwrap();
    for (wire, matches) in [
        (r#""foo\u0000bar""#, true),
        (r#""foo\ud800bar""#, false),
        (r#""foo\udc00bar""#, false),
        (r##""#731\ud800""##, false),
        (r##""#731\udc00""##, false),
        (r#""marker""#, true),
    ] {
        let text: String = garcon_js::json::from_str(wire).unwrap();
        let search = ReaderSearch {
            query: compile_chat_search_query(&text, None),
            order: TranscriptSearchOrder::Allowlist,
            snippet_limit: 1,
            ..options()
        };
        let frames = search_frames(
            search,
            vec![TranscriptSearchAllowedChat {
                through_ordinal: 1,
                ..allowed(CHAT)
            }],
        )
        .unwrap();
        let event = worker
            .request(
                frames.into_iter().map(ReaderRequest::Search),
                None,
                DEADLINE,
                complete,
            )
            .await
            .unwrap();
        let ReaderEvent::SearchResult(result) = event else {
            panic!("expected a normal result for {wire}")
        };
        assert_eq!(
            result
                .results
                .iter()
                .map(|hit| hit.chat_id.as_str())
                .collect::<Vec<_>>(),
            if matches { &[CHAT][..] } else { &[] },
            "{wire}"
        );
    }
    reader.stop(DEADLINE).await.unwrap();
}
