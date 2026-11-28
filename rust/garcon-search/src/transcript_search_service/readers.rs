use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, VecDeque},
    future::pending,
    rc::{Rc, Weak},
};

use garcon_contract::chat_search::{ChatSearchClauseV1, TranscriptSearchAllowedChat};
use serde_json::json;
use tokio::{sync::oneshot, time::Instant};
use tokio_util::sync::CancellationToken;

use crate::{
    query::SearchIndexResult,
    query_frames::search_frames,
    query_latency_stats::QueryLatencySample,
    reader::{ReaderSlot, ReaderWorker, reader_slot},
    worker_protocol::{ReaderEvent, ReaderRequest, ReaderSearch},
    worker_supervisor::{Response, WorkerError},
};

use super::{SearchResult, SearchServiceError, TranscriptSearchService, milliseconds};

const MAX_QUEUED_READERS: usize = 4;

#[cfg(test)]
mod tests;

pub struct TranscriptSearchRequest<'a> {
    pub search: ReaderSearch,
    pub allowed_chats: Vec<TranscriptSearchAllowedChat>,
    pub admission_signal: Option<&'a CancellationToken>,
    pub execution_signal: &'a CancellationToken,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    Busy,
    Quarantined,
}

pub(super) struct Slot {
    pub(super) worker: ReaderSlot,
    state: Cell<State>,
}

type ReaderWaiter = (u64, oneshot::Sender<SearchResult<ReaderLease>>);

pub(super) struct Readers {
    pub(super) slots: [Slot; 2],
    waiters: RefCell<VecDeque<ReaderWaiter>>,
    next_waiter: Cell<u64>,
}

impl Readers {
    pub(super) fn new() -> Self {
        Self {
            slots: std::array::from_fn(|_| Slot {
                worker: reader_slot(),
                state: Cell::new(State::Idle),
            }),
            waiters: RefCell::new(VecDeque::new()),
            next_waiter: Cell::new(0),
        }
    }
}

struct RemoveWaiter<'a> {
    readers: &'a Readers,
    id: u64,
}

impl Drop for RemoveWaiter<'_> {
    fn drop(&mut self) {
        self.readers
            .waiters
            .borrow_mut()
            .retain(|(id, _)| *id != self.id);
    }
}

struct ReaderLease {
    service: Weak<TranscriptSearchService>,
    index: usize,
    worker: ReaderWorker,
    executing: bool,
}

impl Drop for ReaderLease {
    fn drop(&mut self) {
        let Some(service) = self.service.upgrade() else {
            return;
        };
        let slot = &service.readers.slots[self.index];
        if !slot
            .worker
            .current_worker()
            .is_some_and(|current| current.epoch() == self.worker.epoch())
        {
            return;
        }
        if self.executing || !self.worker.available() {
            service.quarantine_reader(self.index);
        } else if slot.state.get() == State::Busy {
            slot.state.set(State::Idle);
            service.dispatch_waiters();
        }
    }
}

async fn optional_abort(signal: Option<&CancellationToken>) {
    if let Some(signal) = signal {
        signal.cancelled().await
    } else {
        pending::<()>().await
    }
}

impl TranscriptSearchService {
    pub(super) fn reader_admitted(self: &Rc<Self>, index: usize) {
        self.readers.slots[index].state.set(State::Idle);
        self.dispatch_waiters();
        self.note_status();
    }

    pub(super) fn quarantine_reader(self: &Rc<Self>, index: usize) {
        let slot = &self.readers.slots[index];
        slot.state.set(State::Quarantined);
        slot.worker.retire();
        self.note_status();
    }

    pub(super) fn reset_reader_slots(&self) {
        for slot in &self.readers.slots {
            slot.state.set(State::Idle);
        }
    }

    pub(super) fn reject_readers(&self) {
        let readers = self.readers.waiters.take();
        for (_, waiter) in readers {
            let _ = waiter.send(Err(SearchServiceError::Unavailable));
        }
    }

    fn try_reader(self: &Rc<Self>) -> Option<ReaderLease> {
        self.readers
            .slots
            .iter()
            .enumerate()
            .find_map(|(index, slot)| {
                if slot.state.get() != State::Idle {
                    return None;
                }
                let worker = slot.worker.worker()?;
                slot.state.set(State::Busy);
                Some(ReaderLease {
                    service: Rc::downgrade(self),
                    index,
                    worker,
                    executing: false,
                })
            })
    }

    fn dispatch_waiters(self: &Rc<Self>) {
        while self.running() && !self.readers.waiters.borrow().is_empty() {
            let Some(lease) = self.try_reader() else {
                return;
            };
            // INFALLIBLE: no other task can remove the checked waiter before this pop.
            let waiter = self
                .readers
                .waiters
                .borrow_mut()
                .pop_front()
                .expect("checked waiters")
                .1;
            let _ = waiter.send(Ok(lease));
        }
    }

    async fn acquire(
        self: &Rc<Self>,
        admission: Option<&CancellationToken>,
        execution: &CancellationToken,
    ) -> SearchResult<ReaderLease> {
        if admission.is_some_and(CancellationToken::is_cancelled) {
            return Err(SearchServiceError::Aborted);
        }
        if execution.is_cancelled() {
            return Err(SearchServiceError::Timeout);
        }
        if let Some(lease) = self.try_reader() {
            return Ok(lease);
        }
        if !self
            .readers
            .slots
            .iter()
            .any(|slot| slot.worker.worker().is_some())
        {
            return Err(SearchServiceError::Unavailable);
        }
        let depth = self.readers.waiters.borrow().len();
        if depth >= MAX_QUEUED_READERS {
            self.latency.borrow_mut().record_rejected_busy();
            self.warn(
                "Transcript search queue overflow",
                "SEARCH_INDEX_BUSY",
                [("depth", json!(depth))],
            );
            return Err(SearchServiceError::Busy);
        }
        let id = self.readers.next_waiter.get() + 1;
        self.readers.next_waiter.set(id);
        let (send, receive) = oneshot::channel();
        self.readers.waiters.borrow_mut().push_back((id, send));
        let _registration = RemoveWaiter {
            readers: &self.readers,
            id,
        };
        tokio::select! { biased;
            () = optional_abort(admission) => Err(SearchServiceError::Aborted),
            () = execution.cancelled() => {
                self.latency.borrow_mut().record_timed_out();
                Err(SearchServiceError::Timeout)
            }
            received = receive => received.unwrap_or(Err(SearchServiceError::Unavailable)),
        }
    }

    pub async fn search(
        self: &Rc<Self>,
        request: TranscriptSearchRequest<'_>,
    ) -> SearchResult<SearchIndexResult> {
        if !self.running() {
            return Err(SearchServiceError::Unavailable);
        }
        if request
            .admission_signal
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(SearchServiceError::Aborted);
        }
        if request.execution_signal.is_cancelled() {
            return Err(SearchServiceError::Timeout);
        }
        let started = Instant::now();
        let mut lease = self
            .acquire(request.admission_signal, request.execution_signal)
            .await?;
        let executing = Instant::now();
        let admission = executing - started;
        let frames = search_frames(request.search.clone(), request.allowed_chats.clone())?;
        let framing = executing.elapsed();
        let session = lease.worker.begin_session()?;
        lease.executing = true;
        let response = tokio::select! { biased;
            () = request.execution_signal.cancelled() => Err(WorkerError::Timeout("SEARCH_TIMEOUT")),
            reply = session.request(frames.into_iter().map(ReaderRequest::Search), None, self.reader_request_timeout, |candidate| {
                if matches!(candidate, ReaderEvent::SearchResult(_)) { Response::Complete } else { Response::Continue }
            }) => reply,
        };
        lease.executing = false;
        let event = match response {
            Ok(event) => event,
            Err(WorkerError::Aborted | WorkerError::Timeout(_)) => {
                self.quarantine_reader(lease.index);
                self.latency.borrow_mut().record_timed_out();
                self.warn_timeout(&request, admission, framing, executing.elapsed());
                return Err(SearchServiceError::Timeout);
            }
            Err(error) => return Err(error.into()),
        };
        drop(lease);
        let ReaderEvent::SearchResult(result) = event else {
            return Err(SearchServiceError::InvalidResponse);
        };
        let options = &request.search;
        if result.mode != options.mode
            || result.snippet_limit != options.snippet_limit
            || result.page.offset != options.offset
            || result.page.limit != options.limit
            || result
                .results
                .iter()
                .any(|hit| hit.snippets.len() > options.snippet_limit)
        {
            return Err(SearchServiceError::InvalidResponse);
        }
        let allowed: HashMap<_, _> = request
            .allowed_chats
            .iter()
            .map(|entry| (&entry.chat_id, &entry.transcript_view_id))
            .collect();
        if result
            .results
            .iter()
            .any(|hit| allowed.get(&hit.chat_id).copied() != Some(&hit.transcript_view_id))
        {
            return Err(SearchServiceError::InvalidResponse);
        }
        let completed = Instant::now();
        self.latency.borrow_mut().record_served(QueryLatencySample {
            admission_ms: milliseconds(admission),
            execution_ms: milliseconds(completed - executing),
            total_ms: milliseconds(completed - started),
        });
        Ok(result)
    }

    fn warn_timeout(
        &self,
        request: &TranscriptSearchRequest<'_>,
        admission: std::time::Duration,
        framing: std::time::Duration,
        execute: std::time::Duration,
    ) {
        let options = &request.search;
        let clauses = &options.query.clauses;
        self.warn(
            "Transcript search query timeout",
            "SEARCH_TIMEOUT",
            [
                ("admissionMs", json!(milliseconds(admission).round() as u64)),
                ("framingMs", json!(milliseconds(framing).round() as u64)),
                ("executeMs", json!(milliseconds(execute).round() as u64)),
                ("allowedChatCount", json!(request.allowed_chats.len())),
                ("clauseCount", json!(clauses.len())),
                (
                    "phraseClauseCount",
                    json!(
                        clauses
                            .iter()
                            .filter(|clause| matches!(clause, ChatSearchClauseV1::Phrase { .. }))
                            .count()
                    ),
                ),
                (
                    "literalClauseCount",
                    json!(
                        clauses
                            .iter()
                            .filter(|clause| matches!(clause, ChatSearchClauseV1::Literal { .. }))
                            .count()
                    ),
                ),
                ("order", json!(options.order)),
                ("offset", json!(options.offset)),
                ("limit", json!(options.limit)),
            ],
        );
    }
}
