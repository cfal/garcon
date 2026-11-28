use std::{
    collections::VecDeque,
    error::Error,
    path::{Path, PathBuf},
};

use async_trait::async_trait;
use garcon_contract::chat_search::{
    ChatSearchResultMode, ChatSearchSnippetRole, TranscriptSearchAllowedChat,
    compile_chat_search_query,
};
use garcon_js::clock::ManualClock;
use tokio::{
    sync::oneshot,
    task::LocalSet,
    time::{sleep, timeout},
};

use crate::{
    query::TranscriptSearchOrder,
    reader::{ReaderSlot, ReaderWorker},
    rows::{HistoricalSearchMessageRow, SearchMessageRowInput},
    schema::{SearchChatStatus, SearchSyncMode},
    worker_protocol::{ReaderEvent, ReaderFrame, ReaderRequest, ReaderSearch},
    worker_supervisor::{SearchWorker, WorkerSlot},
};

use super::*;

const CHAT: &str = "0000000000000001";
const OTHER: &str = "0000000000000002";
const VIEW: &str = "synthetic-view";

#[derive(Default)]
pub(super) struct Logs(RefCell<Vec<String>>);

impl AgentLogger for Logs {
    fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn warn(&self, _: &str, fields: Option<&IndexMap<String, Opaque>>) {
        if let Some(code) = fields
            .and_then(|fields| fields.get("code"))
            .and_then(|code| code.as_str())
        {
            self.0.borrow_mut().push(code.into());
        }
    }
}

pub(super) fn directory() -> tempfile::TempDir {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    let root = home.join("tmp/interface");
    std::fs::create_dir_all(&root).unwrap();
    tempfile::Builder::new()
        .prefix("search-service-")
        .tempdir_in(root)
        .unwrap()
}

pub(super) fn service(path: &Path, logger: Rc<dyn AgentLogger>) -> Rc<TranscriptSearchService> {
    TranscriptSearchService::with_clock(
        TranscriptSearchServiceOptions {
            workspace_directory: path.to_owned(),
            logger,
            reader_request_timeout: None,
        },
        Rc::new(ManualClock::new(1_767_225_600_000)),
    )
}

pub(super) async fn eventually(check: impl Fn() -> bool) {
    timeout(Duration::from_secs(10), async {
        while !check() {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("condition did not settle");
}

fn row(ordinal: u64, body: &str) -> HistoricalSearchMessageRow {
    HistoricalSearchMessageRow {
        ordinal,
        row: SearchMessageRowInput {
            role: ChatSearchSnippetRole::Assistant,
            timestamp: None,
            body: body.into(),
        },
    }
}

struct Frames(VecDeque<TranscriptSearchSyncFrame>);

#[async_trait(?Send)]
impl SearchFrameSource for Frames {
    async fn next(&mut self) -> Result<Option<TranscriptSearchSyncFrame>, Box<dyn Error>> {
        Ok(self.0.pop_front())
    }
}

fn sync_request(
    chat_id: &str,
    target_through: u64,
    frames: Vec<TranscriptSearchSyncFrame>,
) -> TranscriptSearchSyncRequest {
    TranscriptSearchSyncRequest {
        mode: SearchSyncMode::Replace,
        chat_id: chat_id.into(),
        transcript_view_id: VIEW.into(),
        expected_after_ordinal: 0,
        target_through,
        source: Rc::new(move |_| Box::new(Frames(frames.clone().into()))),
    }
}

pub(super) fn search_request<'a>(
    chat: &str,
    through: u64,
    signal: &'a CancellationToken,
) -> TranscriptSearchRequest<'a> {
    TranscriptSearchRequest {
        search: ReaderSearch {
            query: compile_chat_search_query("#731", None),
            order: TranscriptSearchOrder::Relevance,
            mode: ChatSearchResultMode::Page,
            offset: 0,
            limit: 20,
            snippet_limit: 2,
        },
        allowed_chats: vec![TranscriptSearchAllowedChat {
            chat_id: chat.into(),
            transcript_view_id: VIEW.into(),
            through_ordinal: through,
        }],
        admission_signal: None,
        execution_signal: signal,
    }
}

#[tokio::test]
async fn streams_bounded_frames_and_publishes_durable_resync_and_disabled_statuses() {
    LocalSet::new()
        .run_until(async {
            let dir = directory();
            let service = service(dir.path(), Rc::new(Logs::default()));
            let signal = CancellationToken::new();
            assert_eq!(service.status().updated_at, "1970-01-01T00:00:00.000Z");
            let phases = Rc::new(RefCell::new(Vec::new()));
            let listener = phases.clone();
            let _listen = service.on_status_changed(Rc::new(move |status| {
                listener.borrow_mut().push(status.phase)
            }));
            service.enable(&signal).await.unwrap();
            let stale = service.begin_resync(0).unwrap();
            let scope = service.begin_resync(1).unwrap();
            assert!(scope.complete().is_err());
            stale.fail("STALE_SCOPE");

            service
                .sync_chat(sync_request(
                    CHAT,
                    510,
                    vec![
                        TranscriptSearchSyncFrame {
                            rows: (1..=501)
                                .map(|ordinal| row(ordinal, "Synthetic PR #731."))
                                .collect(),
                            advance_to: 501,
                        },
                        TranscriptSearchSyncFrame {
                            rows: vec![],
                            advance_to: 510,
                        },
                    ],
                ))
                .await
                .unwrap();
            assert_eq!(service.chat_states().await.unwrap()[0].indexed_through, 510);
            let result = service
                .search(search_request(CHAT, 510, &signal))
                .await
                .unwrap();
            assert_eq!(result.results[0].matched_message_count, 501);
            assert_eq!(result.results[0].snippets[0].text, "Synthetic PR #731.");
            assert_eq!(service.query_stats().served, 1);

            let mut covered = sync_request(CHAT, 510, vec![]);
            covered.source = Rc::new(|_| panic!("covered plan requested a source"));
            service.sync_chat(covered).await.unwrap();
            scope.chat_settled().unwrap();
            scope.complete().unwrap();
            eventually(|| service.status().phase == TranscriptSearchPhase::Ready).await;
            assert_eq!(service.status().chats.indexed, 1);
            assert_eq!(service.status().last_error_code, None);
            assert_eq!(service.status().updated_at, "2026-01-01T00:00:00.000Z");
            service.disable_and_delete(&signal).await.unwrap();
            eventually(|| service.status().phase == TranscriptSearchPhase::Disabled).await;
            assert_eq!(service.status().chats.total, 0);
            assert_eq!(service.status().chats.indexed, 0);
            assert_eq!(service.status().queued_jobs, 0);
            assert!(!dir.path().join("transcript-search").exists());
            assert!(phases.borrow().contains(&TranscriptSearchPhase::Opening));
            assert!(phases.borrow().contains(&TranscriptSearchPhase::Rebuilding));
            assert!(phases.borrow().contains(&TranscriptSearchPhase::Ready));
            service.close().await;
        })
        .await;
}

#[tokio::test]
async fn short_sources_resume_at_the_durable_frontier_and_append_gaps_do_not_mark_failure() {
    LocalSet::new()
        .run_until(async {
            let dir = directory();
            let service = service(dir.path(), Rc::new(Logs::default()));
            let signal = CancellationToken::new();
            service.enable(&signal).await.unwrap();
            let short = sync_request(
                CHAT,
                2,
                vec![TranscriptSearchSyncFrame {
                    rows: vec![row(1, "Synthetic #731.")],
                    advance_to: 1,
                }],
            );
            assert!(matches!(
                service.sync_chat(short).await,
                Err(SearchServiceError::Gap)
            ));
            let state = &service.chat_states().await.unwrap()[0];
            assert_eq!(
                (state.status, state.indexed_through, state.target_through),
                (SearchChatStatus::Pending, 1, 2)
            );
            assert_eq!(state.last_error_code, None);

            let mut repair = sync_request(CHAT, 2, vec![]);
            repair.source = Rc::new(|after| {
                assert_eq!(after, 1);
                Box::new(Frames(
                    [TranscriptSearchSyncFrame {
                        rows: vec![],
                        advance_to: 2,
                    }]
                    .into(),
                ))
            });
            service.sync_chat(repair).await.unwrap();

            let mut bad_append = sync_request(CHAT, 3, vec![]);
            bad_append.mode = SearchSyncMode::Append;
            bad_append.expected_after_ordinal = 1;
            assert_eq!(
                service.sync_chat(bad_append).await.unwrap_err().to_string(),
                "SEARCH_INDEX_GAP"
            );
            let state = &service.chat_states().await.unwrap()[0];
            assert_eq!(
                (state.status, state.indexed_through),
                (SearchChatStatus::Indexed, 2)
            );
            assert_eq!(state.last_error_code, None);
            service.close().await;
        })
        .await;
}

struct HeldFailure {
    entered: Option<oneshot::Sender<()>>,
    release: Option<oneshot::Receiver<()>>,
}

#[async_trait(?Send)]
impl SearchFrameSource for HeldFailure {
    async fn next(&mut self) -> Result<Option<TranscriptSearchSyncFrame>, Box<dyn Error>> {
        self.entered.take().unwrap().send(()).unwrap();
        self.release.take().unwrap().await.unwrap();
        Err(std::io::Error::other("SYNTHETIC_SOURCE_FAILED").into())
    }
}

struct VerifyDeletion {
    service: Rc<TranscriptSearchService>,
    finished: bool,
}

#[async_trait(?Send)]
impl SearchFrameSource for VerifyDeletion {
    async fn next(&mut self) -> Result<Option<TranscriptSearchSyncFrame>, Box<dyn Error>> {
        if std::mem::replace(&mut self.finished, true) {
            return Ok(None);
        }
        assert!(
            self.service
                .chat_states()
                .await
                .unwrap()
                .iter()
                .all(|state| state.chat_id != OTHER)
        );
        Ok(Some(TranscriptSearchSyncFrame {
            rows: vec![],
            advance_to: 1,
        }))
    }
}

#[tokio::test]
async fn deletion_overtakes_queued_builds_without_stealing_the_active_chat() {
    LocalSet::new()
        .run_until(async {
            let dir = directory();
            let service = service(dir.path(), Rc::new(Logs::default()));
            let signal = CancellationToken::new();
            service.enable(&signal).await.unwrap();
            service
                .sync_chat(sync_request(
                    OTHER,
                    1,
                    vec![TranscriptSearchSyncFrame {
                        rows: vec![row(1, "Synthetic")],
                        advance_to: 1,
                    }],
                ))
                .await
                .unwrap();
            let (entered, entry) = oneshot::channel();
            let (release, hold) = oneshot::channel();
            let mut failing = sync_request(CHAT, 1, vec![]);
            let source = RefCell::new(Some(HeldFailure {
                entered: Some(entered),
                release: Some(hold),
            }));
            failing.source = Rc::new(move |_| Box::new(source.borrow_mut().take().unwrap()));
            let owner = service.clone();
            let first = tokio::task::spawn_local(async move { owner.sync_chat(failing).await });
            entry.await.unwrap();
            assert!(matches!(
                service.delete_chat(CHAT.into()).await,
                Err(SearchServiceError::JobConflict)
            ));
            let mut queued = sync_request("0000000000000003", 1, vec![]);
            let owner = service.clone();
            queued.source = Rc::new(move |_| {
                Box::new(VerifyDeletion {
                    service: owner.clone(),
                    finished: false,
                })
            });
            let owner = service.clone();
            let second = tokio::task::spawn_local(async move { owner.sync_chat(queued).await });
            eventually(|| service.ingest.borrow().queued() == 2).await;
            let owner = service.clone();
            let deletion =
                tokio::task::spawn_local(async move { owner.delete_chat(OTHER.into()).await });
            eventually(|| service.ingest.borrow().queued() == 3).await;
            release.send(()).unwrap();
            assert_eq!(
                first.await.unwrap().unwrap_err().to_string(),
                "SYNTHETIC_SOURCE_FAILED"
            );
            deletion.await.unwrap().unwrap();
            second.await.unwrap().unwrap();
            let states = service.chat_states().await.unwrap();
            assert_eq!(
                states[0].last_error_code.as_deref(),
                Some("SYNTHETIC_SOURCE_FAILED")
            );
            assert_eq!(states[1].status, SearchChatStatus::Indexed);
            service.close().await;
        })
        .await;
}

fn controlled_reader(epoch: u64) -> std::io::Result<ReaderWorker> {
    if epoch >= 3 {
        return crate::reader::spawn_reader(epoch);
    }
    SearchWorker::spawn(
        "test-reader",
        epoch,
        "SEARCH_TIMEOUT",
        move |mut rx, retired| {
            while let Some(command) = rx.blocking_recv() {
                let (reply, close) = match command.request {
                    ReaderRequest::Open(_) if epoch == 2 => (
                        Err(WorkerFailure::new("READER_INTERNAL", true).into()),
                        false,
                    ),
                    ReaderRequest::Open(_) => (Ok(ReaderEvent::Opened), false),
                    ReaderRequest::Close => (Ok(ReaderEvent::Closed), true),
                    ReaderRequest::Search(ReaderFrame::SearchStart(_)) => continue,
                    ReaderRequest::Search(ReaderFrame::SearchAllowlistChunk {
                        done: true, ..
                    }) if epoch == 1 => {
                        tokio::runtime::Builder::new_current_thread()
                            .build()
                            .unwrap()
                            .block_on(retired.cancelled());
                        break;
                    }
                    ReaderRequest::Search(_) => continue,
                };
                let _ = command.reply.send.blocking_send((command.identity, reply));
                if close {
                    break;
                }
            }
        },
    )
}

fn controlled_slot() -> ReaderSlot {
    WorkerSlot::new(
        controlled_reader,
        ReaderRequest::Open,
        || ReaderRequest::Close,
        |event| matches!(event, ReaderEvent::Opened),
        |event| matches!(event, ReaderEvent::Closed),
    )
}

#[tokio::test]
async fn execution_timeout_and_failed_readmission_leave_the_peer_available() {
    LocalSet::new()
        .run_until(async {
            let dir = directory();
            let logs = Rc::new(Logs::default());
            let mut service = service(dir.path(), logs.clone());
            Rc::get_mut(&mut service).unwrap().readers.slots[0].worker = controlled_slot();
            let live = CancellationToken::new();
            service.enable(&live).await.unwrap();
            let original = service.readers.slots[0].worker.worker().unwrap();
            let execution = CancellationToken::new();
            let admission = CancellationToken::new();
            let mut frame = search_request(CHAT, 0, &execution);
            frame.admission_signal = Some(&admission);
            let request = service.search(frame);
            let expire = async {
                // The peer is independent while the first reader is held.
                tokio::task::yield_now().await;
                admission.cancel();
                assert_eq!(
                    service
                        .search(search_request(OTHER, 0, &live))
                        .await
                        .unwrap()
                        .page
                        .total,
                    0
                );
                assert!(original.available());
                execution.cancel();
            };
            let (failure, ()) = tokio::join!(request, expire);
            assert!(matches!(failure, Err(SearchServiceError::Timeout)));
            assert!(!original.available());
            eventually(|| {
                logs.0
                    .borrow()
                    .iter()
                    .any(|code| code == "SEARCH_READER_RESTART_FAILED")
            })
            .await;
            assert!(service.readers.slots[0].worker.worker().is_none());
            assert_eq!(
                service
                    .search(search_request(OTHER, 0, &live))
                    .await
                    .unwrap()
                    .page
                    .total,
                0
            );
            eventually(|| {
                service.readers.slots[0]
                    .worker
                    .worker()
                    .is_some_and(|worker| worker.epoch() == 3)
            })
            .await;
            assert_eq!(
                service
                    .search(search_request(CHAT, 0, &live))
                    .await
                    .unwrap()
                    .page
                    .total,
                0
            );
            assert_eq!(service.query_stats().timed_out, 1);
            assert!(
                logs.0
                    .borrow()
                    .iter()
                    .any(|code| code == "SEARCH_READER_RESTARTED")
            );
            service.close().await;
        })
        .await;
}

fn held_readmission(epoch: u64) -> std::io::Result<ReaderWorker> {
    if epoch == 1 {
        return crate::reader::spawn_reader(epoch);
    }
    SearchWorker::spawn(
        "held-readmission",
        epoch,
        "SEARCH_TIMEOUT",
        move |mut rx, retired| {
            if let Some(command) = rx.blocking_recv() {
                assert!(matches!(command.request, ReaderRequest::Open(_)));
                tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap()
                    .block_on(retired.cancelled());
            }
        },
    )
}

#[tokio::test]
async fn disable_waits_for_a_readmission_in_flight_before_deleting_the_index() {
    LocalSet::new()
        .run_until(async {
            let dir = directory();
            let mut service = service(dir.path(), Rc::new(Logs::default()));
            Rc::get_mut(&mut service).unwrap().readers.slots[0].worker = WorkerSlot::new(
                held_readmission,
                ReaderRequest::Open,
                || ReaderRequest::Close,
                |event| matches!(event, ReaderEvent::Opened),
                |event| matches!(event, ReaderEvent::Closed),
            );
            let signal = CancellationToken::new();
            service.enable(&signal).await.unwrap();
            service.quarantine_reader(0);
            eventually(|| {
                service.readers.slots[0]
                    .worker
                    .current_worker()
                    .is_some_and(|worker| worker.epoch() == 2)
            })
            .await;
            let pending = service.readers.slots[0].worker.current_worker().unwrap();
            assert!(service.readers.slots[0].worker.worker().is_none());
            service.disable_and_delete(&signal).await.unwrap();
            assert!(service.readers.slots[0].worker.current_worker().is_none());
            assert!(!pending.available());
            assert!(!service.db_path.exists());
            service.close().await;
        })
        .await;
}

#[tokio::test]
async fn a_recreated_index_replaces_both_old_reader_connections() {
    LocalSet::new()
        .run_until(async {
            let dir = directory();
            let service = service(dir.path(), Rc::new(Logs::default()));
            let signal = CancellationToken::new();
            service.enable(&signal).await.unwrap();
            service
                .sync_chat(sync_request(
                    CHAT,
                    1,
                    vec![TranscriptSearchSyncFrame {
                        rows: vec![row(1, "Synthetic #731.")],
                        advance_to: 1,
                    }],
                ))
                .await
                .unwrap();
            let resyncs = Rc::new(Cell::new(0));
            let count = resyncs.clone();
            service.set_resync_handler(Rc::new(move || {
                count.set(count.get() + 1);
                Box::pin(async { Ok(()) })
            }));
            let old_readers = service
                .readers
                .slots
                .each_ref()
                .map(|slot| slot.worker.worker().unwrap());
            {
                let broken = rusqlite::Connection::open(&service.db_path).unwrap();
                broken
                    .execute_batch("DROP TRIGGER search_chunks_ad")
                    .unwrap();
            }
            service.indexer.retire();
            eventually(|| {
                resyncs.get() == 1
                    && service.readers.slots.iter().all(|slot| {
                        slot.worker
                            .worker()
                            .is_some_and(|worker| worker.epoch() == 2)
                    })
            })
            .await;
            assert!(old_readers.iter().all(|old| !old.available()));
            assert!(service.chat_states().await.unwrap().is_empty());
            assert_eq!(
                service
                    .search(search_request(CHAT, 1, &signal))
                    .await
                    .unwrap()
                    .page
                    .total,
                0
            );
            service.close().await;
        })
        .await;
}
