use std::{
    collections::{HashSet, VecDeque},
    error::Error,
    rc::Rc,
};

use async_trait::async_trait;
use garcon_contract::chat_search::TranscriptSearchActiveChat;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::{
    indexer::IndexerWorker,
    rows::HistoricalSearchMessageRow,
    schema::{SEARCH_INGEST_ROW_MAX_BYTES, SearchChatState, SearchSyncMode, is_search_error_code},
    worker_protocol::{
        IndexerEvent, IndexerRequest, MAX_FRAME_BYTES, MAX_ROWS_PER_FRAME, WorkerFailure,
        json_byte_len,
    },
    worker_supervisor::{Response, WorkerSession},
};

use super::{REQUEST_TIMEOUT, SearchResult, SearchServiceError, TranscriptSearchService};

const MAINTENANCE_PASSES: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptSearchSyncFrame {
    pub rows: Vec<HistoricalSearchMessageRow>,
    pub advance_to: u64,
}

#[async_trait(?Send)]
/// Supplies bounded ledger pages after the frontier accepted by the writer.
pub trait SearchFrameSource {
    async fn next(&mut self) -> Result<Option<TranscriptSearchSyncFrame>, Box<dyn Error>>;
}

pub struct TranscriptSearchSyncRequest {
    pub mode: SearchSyncMode,
    pub chat_id: String,
    pub transcript_view_id: String,
    pub expected_after_ordinal: u64,
    pub target_through: u64,
    pub source: Rc<dyn Fn(u64) -> Box<dyn SearchFrameSource>>,
}

enum Work {
    Build(TranscriptSearchSyncRequest),
    Delete(String),
    MarkFailed {
        chat_id: String,
        transcript_view_id: String,
        error_code: String,
    },
}

impl Work {
    fn chat_id(&self) -> &str {
        match self {
            Self::Build(request) => &request.chat_id,
            Self::Delete(id) => id,
            Self::MarkFailed { chat_id, .. } => chat_id,
        }
    }
}

struct Job {
    work: Work,
    answer: oneshot::Sender<SearchResult<()>>,
}

#[derive(Default)]
pub(super) struct Ingest {
    urgent: VecDeque<Job>,
    builds: VecDeque<Job>,
    chats: HashSet<String>,
    active: bool,
    pub(super) progress: Option<TranscriptSearchActiveChat>,
}

impl Ingest {
    pub(super) fn queued(&self) -> usize {
        self.urgent.len() + self.builds.len() + usize::from(self.active)
    }

    fn next(&mut self) -> Option<Job> {
        let next = self.urgent.pop_front().or_else(|| self.builds.pop_front());
        self.active = next.is_some();
        next
    }
}

impl TranscriptSearchService {
    pub async fn chat_states(&self) -> SearchResult<Vec<SearchChatState>> {
        let IndexerEvent::ChatStates { states } =
            self.request_indexer(IndexerRequest::ChatStates).await?
        else {
            return Err(SearchServiceError::InvalidResponse);
        };
        Ok(states)
    }

    pub async fn sync_chat(
        self: &Rc<Self>,
        request: TranscriptSearchSyncRequest,
    ) -> SearchResult<()> {
        self.enqueue(Work::Build(request)).await
    }

    pub async fn delete_chat(self: &Rc<Self>, chat_id: String) -> SearchResult<()> {
        self.enqueue(Work::Delete(chat_id)).await
    }

    pub async fn mark_chat_unavailable(
        self: &Rc<Self>,
        chat_id: String,
        transcript_view_id: String,
        error_code: String,
    ) -> SearchResult<()> {
        self.enqueue(Work::MarkFailed {
            chat_id,
            transcript_view_id,
            error_code,
        })
        .await
    }

    async fn enqueue(self: &Rc<Self>, work: Work) -> SearchResult<()> {
        if !self.running() {
            return Ok(());
        }
        let (answer, receive) = oneshot::channel();
        let first = {
            let mut ingest = self.ingest.borrow_mut();
            if !ingest.chats.insert(work.chat_id().into()) {
                return Err(SearchServiceError::JobConflict);
            }
            let queue = if matches!(work, Work::Build(_)) {
                &mut ingest.builds
            } else {
                &mut ingest.urgent
            };
            queue.push_back(Job { work, answer });
            if ingest.active { None } else { ingest.next() }
        };
        self.note_status();
        if let Some(first) = first {
            let service = self.clone();
            let life = self.lifecycle_token();
            tokio::task::spawn_local(async move {
                service.drain_ingest(first, life).await;
            });
        }
        receive
            .await
            .unwrap_or(Err(SearchServiceError::Unavailable))
    }

    pub(super) fn reject_ingest(&self) {
        let mut ingest = self.ingest.borrow_mut();
        let urgent = std::mem::take(&mut ingest.urgent);
        let builds = std::mem::take(&mut ingest.builds);
        for Job { work, answer } in urgent.into_iter().chain(builds) {
            ingest.chats.remove(work.chat_id());
            let _ = answer.send(Err(SearchServiceError::Unavailable));
        }
    }

    async fn drain_ingest(self: &Rc<Self>, mut job: Job, mut life: CancellationToken) {
        loop {
            let outcome = tokio::select! { biased;
                () = life.cancelled() => Err(SearchServiceError::Unavailable),
                result = self.run_job(&job.work, &life) => result,
            };
            let _ = job.answer.send(outcome);
            let next = {
                let mut ingest = self.ingest.borrow_mut();
                ingest.chats.remove(job.work.chat_id());
                ingest.progress = None;
                if self.running() {
                    ingest.next()
                } else {
                    ingest.active = false;
                    None
                }
            };
            self.note_durable();
            let Some(next) = next else { break };
            if life.is_cancelled() {
                life = self.lifecycle_token();
            }
            job = next;
        }
    }

    async fn run_job(self: &Rc<Self>, work: &Work, life: &CancellationToken) -> SearchResult<()> {
        let worker = self
            .indexer
            .worker()
            .ok_or(SearchServiceError::Unavailable)?;
        match work {
            Work::Build(request) => self.run_sync(&worker, request, life).await,
            Work::Delete(chat_id) => self.run_delete(&worker, chat_id).await,
            Work::MarkFailed {
                chat_id,
                transcript_view_id,
                error_code,
            } => {
                let reply = request_worker(
                    &worker,
                    IndexerRequest::MarkFailed {
                        chat_id: chat_id.clone(),
                        transcript_view_id: transcript_view_id.clone(),
                        error_code: error_code.clone(),
                    },
                )
                .await?;
                require_ack(reply)
            }
        }
    }

    pub(super) async fn request_indexer(
        &self,
        input: IndexerRequest,
    ) -> SearchResult<IndexerEvent> {
        let worker = self
            .indexer
            .worker()
            .ok_or(SearchServiceError::Unavailable)?;
        request_worker(&worker, input).await
    }

    async fn run_sync(
        self: &Rc<Self>,
        worker: &IndexerWorker,
        request: &TranscriptSearchSyncRequest,
        life: &CancellationToken,
    ) -> SearchResult<()> {
        let session = worker.begin_session()?;
        let accepted = phase(
            &session,
            IndexerRequest::SyncBegin {
                mode: request.mode,
                chat_id: request.chat_id.clone(),
                transcript_view_id: request.transcript_view_id.clone(),
                expected_after_ordinal: request.expected_after_ordinal,
                target_through: request.target_through,
            },
            |event| matches!(event, IndexerEvent::SyncAccepted { .. }),
        )
        .await?;
        let IndexerEvent::SyncAccepted {
            indexed_through,
            current,
            stale_rows,
        } = accepted
        else {
            return Err(SearchServiceError::InvalidResponse);
        };
        self.note_durable();
        if current {
            return Ok(());
        }
        self.set_progress(indexed_through, request.target_through);
        let result = self
            .stream_sync(&session, request, indexed_through, stale_rows)
            .await;
        if let Err(error) = &result
            && !life.is_cancelled()
        {
            let message = error.to_string();
            if !matches!(
                message.as_str(),
                "SEARCH_INDEX_GAP" | "SEARCH_VIEW_MISMATCH"
            ) {
                let error_code = if is_search_error_code(&message) {
                    message
                } else {
                    "SEARCH_INDEX_UNAVAILABLE".into()
                };
                let _ = request_worker(
                    worker,
                    IndexerRequest::MarkFailed {
                        chat_id: request.chat_id.clone(),
                        transcript_view_id: request.transcript_view_id.clone(),
                        error_code,
                    },
                )
                .await;
            }
        }
        result
    }

    async fn stream_sync(
        self: &Rc<Self>,
        session: &WorkerSession<IndexerRequest, IndexerEvent>,
        request: &TranscriptSearchSyncRequest,
        mut indexed_through: u64,
        mut stale_rows: bool,
    ) -> SearchResult<()> {
        while stale_rows {
            let cleanup = phase(session, IndexerRequest::SyncCleanup, |event| {
                matches!(event, IndexerEvent::CleanupProgress { .. })
            })
            .await?;
            let IndexerEvent::CleanupProgress { remaining, .. } = cleanup else {
                return Err(SearchServiceError::InvalidResponse);
            };
            stale_rows = remaining;
            self.note_durable();
        }
        let mut frame_index = 0;
        let mut source = (request.source)(indexed_through);
        while let Some(frame) = source.next().await.map_err(SearchServiceError::Source)? {
            for chunk in chunk_frame(frame)? {
                let progress = phase(session, IndexerRequest::SyncRows {
                    frame_index, rows: chunk.rows, advance_to: chunk.advance_to,
                }, |event| matches!(event, IndexerEvent::SyncProgress { frame_index: arrived, .. } if *arrived == frame_index)).await?;
                let IndexerEvent::SyncProgress {
                    indexed_through: reached,
                    ..
                } = progress
                else {
                    return Err(SearchServiceError::InvalidResponse);
                };
                frame_index += 1;
                indexed_through = reached;
                self.set_progress(indexed_through, request.target_through);
                self.note_durable();
            }
        }
        if indexed_through != request.target_through {
            return Err(SearchServiceError::Gap);
        }
        phase(session, IndexerRequest::SyncFinish, |event| {
            matches!(event, IndexerEvent::SyncComplete { .. })
        })
        .await?;
        Ok(())
    }

    fn set_progress(&self, position: u64, total: u64) {
        self.ingest.borrow_mut().progress = Some(TranscriptSearchActiveChat { position, total });
    }

    async fn run_delete(
        self: &Rc<Self>,
        worker: &IndexerWorker,
        chat_id: &str,
    ) -> SearchResult<()> {
        require_ack(
            request_worker(
                worker,
                IndexerRequest::DeleteChat {
                    chat_id: chat_id.into(),
                },
            )
            .await?,
        )?;
        self.note_durable();
        if !matches!(
            request_worker(worker, IndexerRequest::Checkpoint).await,
            Ok(IndexerEvent::CheckpointComplete { busy: 0 })
        ) {
            self.warn(
                "Transcript search checkpoint deferred.",
                "SEARCH_WAL_TRUNCATE_DEFERRED",
                [],
            );
        }
        for _ in 0..MAINTENANCE_PASSES {
            if !matches!(
                request_worker(worker, IndexerRequest::Maintenance).await,
                Ok(IndexerEvent::Ack)
            ) {
                break;
            }
        }
        Ok(())
    }
}

async fn request_worker(
    worker: &IndexerWorker,
    input: IndexerRequest,
) -> SearchResult<IndexerEvent> {
    Ok(worker
        .request([input], None, REQUEST_TIMEOUT, |event| {
            if matches!(event, IndexerEvent::DeleteProgress { .. }) {
                Response::Progress
            } else {
                Response::Complete
            }
        })
        .await?)
}

async fn phase(
    session: &WorkerSession<IndexerRequest, IndexerEvent>,
    input: IndexerRequest,
    matches: impl Fn(&IndexerEvent) -> bool,
) -> SearchResult<IndexerEvent> {
    Ok(session
        .request([input], None, REQUEST_TIMEOUT, |event| {
            if matches(event) {
                Response::Complete
            } else {
                Response::Continue
            }
        })
        .await?)
}

fn require_ack(event: IndexerEvent) -> SearchResult<()> {
    if event == IndexerEvent::Ack {
        Ok(())
    } else {
        Err(SearchServiceError::InvalidResponse)
    }
}

fn chunk_frame(frame: TranscriptSearchSyncFrame) -> SearchResult<Vec<TranscriptSearchSyncFrame>> {
    let mut chunks = Vec::new();
    let mut rows: Vec<HistoricalSearchMessageRow> = Vec::new();
    let mut bytes = 2;
    for row in frame.rows {
        if row.row.body.len() > SEARCH_INGEST_ROW_MAX_BYTES {
            return Err(WorkerFailure::new("SEARCH_ROW_TOO_LARGE", false).into());
        }
        let row_bytes = json_byte_len(&row)
            .map_err(|error| SearchServiceError::Source(Box::new(error)))?
            + usize::from(!rows.is_empty());
        if (rows.len() >= MAX_ROWS_PER_FRAME || bytes + row_bytes > MAX_FRAME_BYTES)
            && let Some(last) = rows.last()
        {
            chunks.push(TranscriptSearchSyncFrame {
                advance_to: last.ordinal,
                rows: std::mem::take(&mut rows),
            });
            bytes = 2;
        }
        rows.push(row);
        bytes += row_bytes;
    }
    chunks.push(TranscriptSearchSyncFrame {
        rows,
        advance_to: frame.advance_to,
    });
    Ok(chunks)
}
