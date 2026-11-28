use std::{cell::RefCell, collections::HashMap, ops::Range, rc::Rc, time::Duration};

use garcon_js::SystemClock;
use rusqlite::Connection;
use tokio::{
    sync::{mpsc, oneshot},
    task::{JoinSet, LocalSet},
    time::{Instant, sleep},
};
use tokio_util::sync::CancellationToken;

use crate::{
    rows::HistoricalSearchMessageRow,
    schema::{
        DeleteStaleRows, InsertRowsBatch, PlanChatSync, SEARCH_INGEST_TXN_MAX_BYTES,
        SEARCH_INGEST_TXN_MAX_ROWS, SearchSchemaResult, SearchSyncPlan, close_search_database,
        delete_chat_batch, delete_stale_rows_batch, finish_chat_sync, insert_rows_batch,
        is_search_error_code, list_chat_states, mark_chat_failed, observe_wal_truncate,
        open_search_database, plan_chat_sync, run_idle_maintenance, status_counts,
    },
    worker_protocol::{
        IndexerEvent, IndexerRequest, WorkerFailure, valid_indexer_event, valid_indexer_request,
    },
    worker_supervisor::{CHANNEL_CAPACITY, Command, Reply, SearchWorker, WorkerError, WorkerSlot},
};

const CLEANUP_BATCHES: usize = 8;
const CHECKPOINT_ATTEMPTS: usize = 5;
const CHECKPOINT_DELAY: Duration = Duration::from_secs(1);

#[cfg(test)]
mod tests;

pub type IndexerWorker = SearchWorker<IndexerRequest, IndexerEvent>;
pub type IndexerSlot = WorkerSlot<IndexerRequest, IndexerEvent>;

pub fn indexer_slot() -> IndexerSlot {
    WorkerSlot::new(
        spawn_indexer,
        IndexerRequest::Open,
        || IndexerRequest::Close,
        |event| matches!(event, IndexerEvent::Opened { .. }),
        |event| matches!(event, IndexerEvent::Closed),
    )
}

pub fn spawn_indexer(epoch: u64) -> std::io::Result<IndexerWorker> {
    SearchWorker::spawn(
        "garcon-transcript-search-indexer",
        epoch,
        "WORKER_TIMEOUT",
        move |mut receiver, retired| {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
            else {
                return;
            };
            let tasks = LocalSet::new();
            runtime.block_on(tasks.run_until(run(epoch, &mut receiver, &retired)));
        },
    )
}

struct ActiveSync {
    chat_id: String,
    transcript_view_id: String,
    indexed_through: u64,
    next_frame_index: u64,
    stale_rows_remaining: bool,
}

#[derive(Default)]
struct Indexer {
    db: Option<Connection>,
    open_generation: u64,
    syncs: HashMap<u64, ActiveSync>,
    duty_debt: Duration,
    closing: bool,
}

async fn run(
    epoch: u64,
    receiver: &mut mpsc::Receiver<Command<IndexerRequest, IndexerEvent>>,
    retired: &CancellationToken,
) {
    let state = Rc::new(RefCell::new(Indexer::default()));
    let closed = CancellationToken::new();
    let mut calls: JoinSet<()> = JoinSet::new();
    loop {
        let command = tokio::select! {
            biased;
            () = retired.cancelled() => break,
            () = closed.cancelled() => break,
            done = calls.join_next(), if !calls.is_empty() => {
                if let Some(Err(error)) = done {
                    if error.is_panic() { std::panic::resume_unwind(error.into_panic()); }
                    break;
                }
                continue;
            }
            command = receiver.recv(), if calls.len() < CHANNEL_CAPACITY => command,
        };
        let Some(command) = command else { break };
        if command.identity.epoch != epoch {
            continue;
        }
        let (start, started) = oneshot::channel();
        let state = state.clone();
        let closed = closed.clone();
        calls.spawn_local(async move {
            let _ = start.send(());
            handle(&state, command, &closed).await;
        });
        // Each task starts before the next message is dispatched. Only its duty waits interleave work.
        let _ = started.await;
    }
}

type IndexerResult<T> = Result<T, WorkerFailure>;

fn unavailable() -> WorkerFailure {
    WorkerFailure::new("INDEXER_UNAVAILABLE", true)
}

fn schema_failure(error: crate::schema::SearchSchemaError) -> WorkerFailure {
    let message = error.to_string();
    if is_search_error_code(&message) {
        WorkerFailure::new(message, false)
    } else {
        WorkerFailure::new("INDEXER_INTERNAL", true)
    }
}

async fn emit(reply: &Reply<IndexerEvent>, result: IndexerResult<IndexerEvent>) {
    let output = match result {
        Ok(event) if !valid_indexer_event(&event) => Err(WorkerError::InvalidMessage),
        Ok(event) => Ok(event),
        Err(error) => Err(error.into()),
    };
    let _ = reply.send.send((reply.identity, output)).await;
}

async fn handle(
    state: &RefCell<Indexer>,
    Command {
        identity,
        request,
        reply,
    }: Command<IndexerRequest, IndexerEvent>,
    closed: &CancellationToken,
) {
    if !valid_indexer_request(&request) {
        emit(
            &reply,
            Err(WorkerFailure::new("INVALID_INDEXER_REQUEST", false)),
        )
        .await;
        return;
    }
    let close = matches!(request, IndexerRequest::Close);
    let result = process(state, identity.request_id, request, &reply).await;
    if result.is_err() {
        state.borrow_mut().syncs.remove(&identity.request_id);
    }
    emit(&reply, result).await;
    if close {
        closed.cancel();
    }
}

impl Indexer {
    fn db(&self) -> IndexerResult<&Connection> {
        if self.closing {
            return Err(unavailable());
        }
        self.db.as_ref().ok_or_else(unavailable)
    }

    fn sync(&mut self, request_id: u64) -> IndexerResult<ActiveSync> {
        self.syncs
            .remove(&request_id)
            .ok_or_else(|| WorkerFailure::new("INVALID_INDEX_REQUEST", false))
    }

    fn db_in(&self, generation: u64) -> IndexerResult<&Connection> {
        if generation != self.open_generation {
            return Err(unavailable());
        }
        self.db()
    }
}

async fn pay_duty<T>(
    state: &RefCell<Indexer>,
    generation: u64,
    work: impl FnOnce(&Connection) -> SearchSchemaResult<T>,
) -> IndexerResult<T> {
    let started = Instant::now();
    let result = work(state.borrow().db_in(generation)?).map_err(schema_failure);
    let delay = {
        let mut state = state.borrow_mut();
        state.duty_debt += started.elapsed();
        let delay = Duration::from_millis(state.duty_debt.as_millis() as u64);
        state.duty_debt -= delay;
        delay
    };
    if delay.is_zero() {
        tokio::task::yield_now().await;
    } else {
        sleep(delay).await;
    }
    result
}

fn batch_ranges(rows: &[HistoricalSearchMessageRow]) -> Vec<Range<usize>> {
    let mut slices = Vec::new();
    let mut start = 0;
    let mut bytes = 0;
    for (index, message) in rows.iter().enumerate() {
        let row = &message.row;
        let size = row.body.len() + row.timestamp.as_ref().map_or(0, String::len);
        if index - start >= SEARCH_INGEST_TXN_MAX_ROWS
            || (index > start && bytes + size > SEARCH_INGEST_TXN_MAX_BYTES)
        {
            slices.push(start..index);
            start = index;
            bytes = 0;
        }
        bytes += size;
    }
    if start < rows.len() {
        slices.push(start..rows.len());
    }
    slices
}

async fn apply_rows(
    state: &RefCell<Indexer>,
    generation: u64,
    sync: &mut ActiveSync,
    rows: &[HistoricalSearchMessageRow],
    advance_to: u64,
) -> IndexerResult<()> {
    let mut batches = batch_ranges(rows);
    if batches.is_empty() && advance_to > sync.indexed_through {
        batches.push(0..0);
    }
    for batch in batches {
        let batch_end = if batch.end == rows.len() {
            advance_to
        } else {
            rows[batch.end - 1].ordinal
        };
        let result = pay_duty(state, generation, |db| {
            insert_rows_batch(
                db,
                InsertRowsBatch {
                    chat_id: &sync.chat_id,
                    transcript_view_id: &sync.transcript_view_id,
                    rows: &rows[batch],
                    advance_to: batch_end,
                },
                &SystemClock,
            )
        })
        .await?;
        sync.indexed_through = result.indexed_through;
        state.borrow().db_in(generation)?;
    }
    Ok(())
}

async fn process(
    state: &RefCell<Indexer>,
    request_id: u64,
    request: IndexerRequest,
    reply: &Reply<IndexerEvent>,
) -> IndexerResult<IndexerEvent> {
    use IndexerRequest::*;
    let generation = state.borrow().open_generation;
    match request {
        Open(path) => {
            let mut state = state.borrow_mut();
            state.closing = false;
            state.open_generation = state.open_generation.wrapping_add(1);
            state.syncs.clear();
            if let Some(db) = state.db.take() {
                close_search_database(db).map_err(schema_failure)?;
            }
            let opened = open_search_database(&path).map_err(schema_failure)?;
            state.db = Some(opened.db);
            Ok(IndexerEvent::Opened {
                recreated: opened.recreated,
            })
        }
        ChatStates => {
            let states = list_chat_states(state.borrow().db()?).map_err(schema_failure)?;
            Ok(IndexerEvent::ChatStates { states })
        }
        SyncBegin {
            mode,
            chat_id,
            transcript_view_id,
            expected_after_ordinal,
            target_through,
        } => {
            let mut state = state.borrow_mut();
            let db = state.db()?;
            if state.syncs.contains_key(&request_id) {
                return Err(WorkerFailure::new("INVALID_INDEX_REQUEST", false));
            }
            let plan = plan_chat_sync(
                db,
                PlanChatSync {
                    mode,
                    chat_id: &chat_id,
                    transcript_view_id: &transcript_view_id,
                    expected_after_ordinal,
                    target_through,
                },
                &SystemClock,
            )
            .map_err(schema_failure)?;
            match plan {
                SearchSyncPlan::Current { state } => Ok(IndexerEvent::SyncAccepted {
                    indexed_through: state.indexed_through,
                    current: true,
                    stale_rows: false,
                }),
                SearchSyncPlan::Build {
                    state: chat,
                    stale_rows,
                } => {
                    state.syncs.insert(
                        request_id,
                        ActiveSync {
                            chat_id,
                            transcript_view_id,
                            indexed_through: chat.indexed_through,
                            next_frame_index: 0,
                            stale_rows_remaining: stale_rows,
                        },
                    );
                    Ok(IndexerEvent::SyncAccepted {
                        indexed_through: chat.indexed_through,
                        current: false,
                        stale_rows,
                    })
                }
            }
        }
        SyncCleanup => {
            state.borrow().db()?;
            let mut sync = state.borrow_mut().sync(request_id)?;
            let mut deleted_rows = 0;
            for _ in 0..CLEANUP_BATCHES {
                if !sync.stale_rows_remaining {
                    break;
                }
                let deleted = pay_duty(state, generation, |db| {
                    delete_stale_rows_batch(
                        db,
                        DeleteStaleRows {
                            chat_id: &sync.chat_id,
                            keep_view_id: &sync.transcript_view_id,
                            keep_through: sync.indexed_through,
                            limit: None,
                        },
                    )
                })
                .await?;
                deleted_rows += deleted;
                sync.stale_rows_remaining = deleted > 0;
                state.borrow().db_in(generation)?;
            }
            let remaining = sync.stale_rows_remaining;
            state.borrow_mut().syncs.insert(request_id, sync);
            Ok(IndexerEvent::CleanupProgress {
                deleted_rows,
                remaining,
            })
        }
        SyncRows {
            frame_index,
            rows,
            advance_to,
        } => {
            let mut sync = state.borrow_mut().sync(request_id)?;
            if sync.stale_rows_remaining || sync.next_frame_index != frame_index {
                return Err(WorkerFailure::new("INVALID_INDEX_FRAME", false));
            }
            sync.next_frame_index += 1;
            apply_rows(state, generation, &mut sync, &rows, advance_to).await?;
            let indexed_through = sync.indexed_through;
            state.borrow_mut().syncs.insert(request_id, sync);
            Ok(IndexerEvent::SyncProgress {
                frame_index,
                indexed_through,
            })
        }
        SyncFinish => {
            let mut state = state.borrow_mut();
            let sync = state.sync(request_id)?;
            if sync.stale_rows_remaining {
                return Err(WorkerFailure::new("INVALID_INDEX_FRAME", false));
            }
            let state = finish_chat_sync(
                state.db()?,
                &sync.chat_id,
                &sync.transcript_view_id,
                &SystemClock,
            )
            .map_err(schema_failure)?;
            Ok(IndexerEvent::SyncComplete { state })
        }
        MarkFailed {
            chat_id,
            transcript_view_id,
            error_code,
        } => {
            mark_chat_failed(
                state.borrow().db()?,
                &chat_id,
                &transcript_view_id,
                &error_code,
                &SystemClock,
            )
            .map_err(schema_failure)?;
            Ok(IndexerEvent::Ack)
        }
        DeleteChat { chat_id } => {
            loop {
                let batch = pay_duty(state, generation, |db| {
                    delete_chat_batch(db, &chat_id, None)
                })
                .await?;
                if batch.deleted_rows > 0 {
                    emit(
                        reply,
                        Ok(IndexerEvent::DeleteProgress {
                            deleted_rows: batch.deleted_rows,
                        }),
                    )
                    .await;
                }
                if batch.done {
                    break;
                }
            }
            Ok(IndexerEvent::Ack)
        }
        Maintenance => {
            pay_duty(state, generation, run_idle_maintenance).await?;
            Ok(IndexerEvent::Ack)
        }
        StatusSnapshot => {
            let counts = status_counts(state.borrow().db()?).map_err(schema_failure)?;
            Ok(IndexerEvent::Status { counts })
        }
        Checkpoint => {
            for _ in 0..CHECKPOINT_ATTEMPTS {
                if observe_wal_truncate(state.borrow().db_in(generation)?)
                    .map_err(schema_failure)?
                    .busy
                    == 0
                {
                    return Ok(IndexerEvent::CheckpointComplete { busy: 0 });
                }
                sleep(CHECKPOINT_DELAY).await;
            }
            Ok(IndexerEvent::CheckpointComplete { busy: 1 })
        }
        Close => {
            let mut state = state.borrow_mut();
            state.closing = true;
            state.syncs.clear();
            if let Some(db) = state.db.take() {
                close_search_database(db).map_err(schema_failure)?;
            }
            Ok(IndexerEvent::Closed)
        }
    }
}
