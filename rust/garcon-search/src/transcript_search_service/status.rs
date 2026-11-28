use std::{
    collections::BTreeMap,
    ops::Bound::{Excluded, Unbounded},
    rc::{Rc, Weak},
    time::Duration,
};

use garcon_contract::chat_search::{
    TranscriptSearchChatCounts, TranscriptSearchPhase, TranscriptSearchResync,
    TranscriptSearchStatusV1,
};
use garcon_js::to_iso_string;
use serde_json::json;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

use crate::{
    schema::{MAX_SAFE_ORDINAL, SearchStatusCounts, is_search_error_code},
    worker_protocol::{IndexerEvent, IndexerRequest},
};

use super::{SearchResult, SearchServiceError, TranscriptSearchService};

const COALESCE: Duration = Duration::from_millis(250);
const COUNTS_RETRY_DELAY: Duration = Duration::from_secs(1);

#[cfg(test)]
mod tests;

pub type SearchStatusListener = Rc<dyn Fn(&TranscriptSearchStatusV1)>;

pub struct SearchStatusSubscription {
    service: Weak<TranscriptSearchService>,
    id: u64,
}

impl Drop for SearchStatusSubscription {
    fn drop(&mut self) {
        if let Some(service) = self.service.upgrade() {
            service.status.borrow_mut().listeners.remove(&self.id);
        }
    }
}

pub struct TranscriptSearchResyncScope {
    service: Weak<TranscriptSearchService>,
    id: u64,
}

struct ActiveResync {
    id: u64,
    progress: TranscriptSearchResync,
}

pub(super) struct Status {
    listeners: BTreeMap<u64, SearchStatusListener>,
    next_listener: u64,
    next_resync: u64,
    resync: Option<ActiveResync>,
    catalog_total: u64,
    catalog_current: bool,
    counts: SearchStatusCounts,
    last_error: Option<String>,
    last: TranscriptSearchStatusV1,
    dirty: bool,
    counts_dirty: bool,
    counts_revision: u64,
    active: bool,
    retry: Option<CancellationToken>,
    retry_armed: bool,
    emit: Option<CancellationToken>,
    emit_pending: bool,
}

impl Default for Status {
    fn default() -> Self {
        Self {
            listeners: BTreeMap::new(),
            next_listener: 0,
            next_resync: 0,
            resync: None,
            catalog_total: 0,
            catalog_current: false,
            counts: empty_counts(),
            last_error: None,
            last: TranscriptSearchStatusV1 {
                version: 1,
                phase: TranscriptSearchPhase::Disabled,
                chats: TranscriptSearchChatCounts {
                    total: 0,
                    indexed: 0,
                    pending: 0,
                    failed: 0,
                    unindexed: 0,
                },
                queued_jobs: 0,
                resync: None,
                backlog_rows: 0,
                active_chat: None,
                last_error_code: None,
                updated_at: "1970-01-01T00:00:00.000Z".into(),
            },
            dirty: false,
            counts_dirty: false,
            counts_revision: 0,
            active: false,
            retry: None,
            retry_armed: false,
            emit: None,
            emit_pending: false,
        }
    }
}

fn empty_counts() -> SearchStatusCounts {
    SearchStatusCounts {
        indexed: 0,
        pending: 0,
        failed: 0,
        backlog_rows: 0,
    }
}

impl TranscriptSearchService {
    pub fn status(&self) -> TranscriptSearchStatusV1 {
        self.status.borrow().last.clone()
    }

    #[must_use]
    pub fn on_status_changed(
        self: &Rc<Self>,
        listener: SearchStatusListener,
    ) -> SearchStatusSubscription {
        let mut status = self.status.borrow_mut();
        let existing = status
            .listeners
            .iter()
            .find_map(|(id, registered)| Rc::ptr_eq(registered, &listener).then_some(*id));
        let id = existing.unwrap_or_else(|| {
            status.next_listener += 1;
            let id = status.next_listener;
            status.listeners.insert(id, listener);
            id
        });
        SearchStatusSubscription {
            service: Rc::downgrade(self),
            id,
        }
    }

    pub fn begin_resync(
        self: &Rc<Self>,
        total_chats: u64,
    ) -> SearchResult<TranscriptSearchResyncScope> {
        if total_chats > MAX_SAFE_ORDINAL {
            return Err(SearchServiceError::ResyncInvariant);
        }
        let id = {
            let mut status = self.status.borrow_mut();
            status.next_resync += 1;
            let id = status.next_resync;
            status.catalog_total = total_chats;
            status.resync = Some(ActiveResync {
                id,
                progress: TranscriptSearchResync {
                    completed_chats: 0,
                    total_chats,
                },
            });
            id
        };
        self.note_status();
        Ok(TranscriptSearchResyncScope {
            service: Rc::downgrade(self),
            id,
        })
    }

    pub fn set_catalog_chat_total(self: &Rc<Self>, total_chats: u64) -> SearchResult<()> {
        if total_chats > MAX_SAFE_ORDINAL {
            return Err(SearchServiceError::ResyncInvariant);
        }
        {
            let mut status = self.status.borrow_mut();
            if status.catalog_total == total_chats {
                return Ok(());
            }
            status.catalog_total = total_chats;
        }
        self.note_status();
        Ok(())
    }

    pub fn record_resync_failure(self: &Rc<Self>, error_code: &str) {
        let code = if is_search_error_code(error_code) {
            error_code
        } else {
            "SEARCH_RESYNC_FAILED"
        };
        {
            let mut status = self.status.borrow_mut();
            status.catalog_current = false;
            status.last_error = Some(code.into());
        }
        self.note_status();
    }

    pub(super) fn set_last_error(&self, code: Option<String>) {
        self.status.borrow_mut().last_error = code;
    }

    pub(super) fn reset_status(&self) {
        self.ingest.borrow_mut().progress = None;
        let mut status = self.status.borrow_mut();
        status.catalog_total = 0;
        status.catalog_current = false;
        status.counts = empty_counts();
        status.resync = None;
        status.last_error = None;
        status.counts_dirty = false;
        drop(status);
        self.clear_counts_retry();
    }

    pub(super) fn clear_counts_retry(&self) {
        let mut status = self.status.borrow_mut();
        status.retry_armed = false;
        if let Some(retry) = status.retry.take() {
            retry.cancel();
        }
    }

    pub(super) fn clear_status_timers(&self) {
        self.clear_counts_retry();
        if let Some(emit) = self.status.borrow_mut().emit.take() {
            emit.cancel();
        }
    }

    pub(super) fn note_durable(self: &Rc<Self>) {
        {
            let mut status = self.status.borrow_mut();
            status.counts_dirty = true;
            status.counts_revision = status.counts_revision.wrapping_add(1);
        }
        self.note_status();
    }

    pub(super) fn note_status(self: &Rc<Self>) {
        let refresh = {
            let mut status = self.status.borrow_mut();
            status.dirty = true;
            if status.active {
                return;
            }
            if !self.running() {
                status.counts_dirty = false;
            }
            if status.counts_dirty {
                status.active = true;
                true
            } else {
                status.dirty = false;
                false
            }
        };
        if refresh {
            let service = self.clone();
            let life = self.lifecycle_token();
            tokio::task::spawn_local(async move {
                service.refresh_status(&life).await;
            });
        } else {
            self.publish_status();
        }
    }

    async fn refresh_status(self: &Rc<Self>, life: &CancellationToken) {
        loop {
            if life.is_cancelled() {
                self.status.borrow_mut().active = false;
                if !self.closed.get() {
                    self.note_status();
                }
                return;
            }
            let snapshot = {
                let mut status = self.status.borrow_mut();
                if !self.running() {
                    status.counts_dirty = false;
                }
                status.counts_dirty.then_some(status.counts_revision)
            };
            if let Some(revision) = snapshot {
                let event = tokio::select! { biased;
                    () = life.cancelled() => {
                        self.status.borrow_mut().active = false;
                        if !self.closed.get() { self.note_status(); }
                        return;
                    }
                    reply = self.request_indexer(IndexerRequest::StatusSnapshot) => reply,
                };
                let Ok(IndexerEvent::Status { counts }) = event else {
                    self.status.borrow_mut().active = false;
                    self.schedule_retry();
                    return;
                };
                let mut status = self.status.borrow_mut();
                // Separate reply channels can wake a newer write before this snapshot is consumed.
                if revision != status.counts_revision {
                    continue;
                }
                status.counts_dirty = false;
                status.counts = counts;
                status.retry_armed = false;
            }
            self.status.borrow_mut().dirty = false;
            self.publish_status();
            let mut status = self.status.borrow_mut();
            if !status.dirty && !status.counts_dirty {
                status.active = false;
                break;
            }
        }
    }

    fn schedule_retry(self: &Rc<Self>) {
        let timer = {
            let mut status = self.status.borrow_mut();
            if status.retry_armed || status.retry.is_some() || !self.running() {
                return;
            }
            status.retry_armed = true;
            let timer = self.lifecycle_token().child_token();
            status.retry = Some(timer.clone());
            timer
        };
        let weak = Rc::downgrade(self);
        tokio::task::spawn_local(async move {
            tokio::select! { biased;
                () = timer.cancelled() => {},
                () = sleep(COUNTS_RETRY_DELAY) => {
                    if let Some(service) = weak.upgrade() {
                        service.status.borrow_mut().retry.take();
                        service.note_status();
                    }
                }
            }
        });
    }

    fn publish_status(self: &Rc<Self>) {
        let immediate = {
            let mut status = self.status.borrow_mut();
            let ingest = self.ingest.borrow();
            let counts = status.counts;
            let accounted = counts.indexed + counts.pending + counts.failed;
            let mut content = TranscriptSearchStatusV1 {
                version: 1,
                phase: self.phase(&status, ingest.queued()),
                chats: TranscriptSearchChatCounts {
                    total: status.catalog_total,
                    indexed: counts.indexed,
                    pending: counts.pending,
                    failed: counts.failed,
                    unindexed: status.catalog_total.saturating_sub(accounted),
                },
                queued_jobs: ingest.queued() as u64,
                resync: status.resync.as_ref().map(|resync| resync.progress),
                backlog_rows: counts.backlog_rows,
                active_chat: ingest.progress,
                last_error_code: status.last_error.clone(),
                updated_at: status.last.updated_at.clone(),
            };
            if content == status.last {
                return;
            }
            let immediate = content.phase != status.last.phase;
            content.updated_at = match to_iso_string(self.clock.now_ms()) {
                Ok(time) => time,
                Err(error) => {
                    drop(ingest);
                    drop(status);
                    self.logger
                        .error(&format!("unhandled rejection (non-fatal): {error}"), None);
                    return;
                }
            };
            status.last = content;
            status.emit_pending = true;
            immediate
        };
        if immediate {
            if let Some(emit) = self.status.borrow_mut().emit.take() {
                emit.cancel();
            }
            self.emit_status();
        } else {
            self.schedule_emit();
        }
    }

    fn phase(&self, status: &Status, jobs: usize) -> TranscriptSearchPhase {
        use TranscriptSearchPhase::*;
        if self.closed.get() || (!self.enabled.get() && self.phase_override.get().is_none()) {
            return Disabled;
        }
        if let Some(phase) = self.phase_override.get() {
            return phase;
        }
        if self.indexer.worker().is_none()
            || self
                .readers
                .slots
                .iter()
                .any(|slot| slot.worker.worker().is_none())
        {
            return Degraded;
        }
        if status.resync.is_some() || jobs > 0 {
            return Rebuilding;
        }
        let counts = status.counts;
        if !status.catalog_current
            || counts.failed > 0
            || counts.pending > 0
            || status.catalog_total > counts.indexed + counts.pending + counts.failed
        {
            return Degraded;
        }
        Ready
    }

    fn schedule_emit(self: &Rc<Self>) {
        let timer = {
            let mut status = self.status.borrow_mut();
            if status.emit.is_some() || self.closed.get() {
                return;
            }
            let timer = CancellationToken::new();
            status.emit = Some(timer.clone());
            timer
        };
        let weak = Rc::downgrade(self);
        tokio::task::spawn_local(async move {
            tokio::select! { biased;
                () = timer.cancelled() => {},
                () = sleep(COALESCE) => {
                    if let Some(service) = weak.upgrade() {
                        service.status.borrow_mut().emit.take();
                        service.emit_status();
                    }
                }
            }
        });
    }

    fn emit_status(&self) {
        let snapshot = {
            let mut status = self.status.borrow_mut();
            if !status.emit_pending {
                return;
            }
            status.emit_pending = false;
            status.last.clone()
        };
        if snapshot.phase == TranscriptSearchPhase::Rebuilding
            && self.log_allowed("SEARCH_INGEST_PROGRESS")
        {
            self.logger.info(
                "Transcript search ingest progress",
                Some(&Self::log_fields(
                    "SEARCH_INGEST_PROGRESS",
                    [
                        ("chatsTotal", json!(snapshot.chats.total)),
                        ("chatsIndexed", json!(snapshot.chats.indexed)),
                        ("chatsPending", json!(snapshot.chats.pending)),
                        ("chatsFailed", json!(snapshot.chats.failed)),
                        ("chatsUnindexed", json!(snapshot.chats.unindexed)),
                        (
                            "resyncCompleted",
                            json!(snapshot.resync.map(|resync| resync.completed_chats)),
                        ),
                        (
                            "resyncTotal",
                            json!(snapshot.resync.map(|resync| resync.total_chats)),
                        ),
                        ("backlogRows", json!(snapshot.backlog_rows)),
                        ("queuedJobs", json!(snapshot.queued_jobs)),
                        (
                            "activePosition",
                            json!(snapshot.active_chat.map(|chat| chat.position)),
                        ),
                        (
                            "activeTotal",
                            json!(snapshot.active_chat.map(|chat| chat.total)),
                        ),
                    ],
                )),
            );
        }
        let mut last = 0;
        loop {
            let next = self
                .status
                .borrow()
                .listeners
                .range((Excluded(last), Unbounded))
                .next()
                .map(|(&id, listener)| (id, listener.clone()));
            let Some((id, listener)) = next else { break };
            last = id;
            listener(&snapshot);
        }
    }
}

impl TranscriptSearchResyncScope {
    pub fn chat_settled(&self) -> SearchResult<()> {
        let Some(service) = self.service.upgrade() else {
            return Ok(());
        };
        {
            let mut status = service.status.borrow_mut();
            let Some(resync) = status.resync.as_mut().filter(|scope| scope.id == self.id) else {
                return Ok(());
            };
            if resync.progress.completed_chats >= resync.progress.total_chats {
                return Err(SearchServiceError::ResyncInvariant);
            }
            resync.progress.completed_chats += 1;
        }
        service.note_status();
        Ok(())
    }

    pub fn complete(&self) -> SearchResult<()> {
        let Some(service) = self.service.upgrade() else {
            return Ok(());
        };
        {
            let mut status = service.status.borrow_mut();
            let Some(resync) = status.resync.as_ref().filter(|scope| scope.id == self.id) else {
                return Ok(());
            };
            if resync.progress.completed_chats != resync.progress.total_chats {
                return Err(SearchServiceError::ResyncInvariant);
            }
            status.resync = None;
            status.catalog_current = true;
            status.last_error = None;
        }
        service.note_durable();
        Ok(())
    }

    pub fn fail(&self, code: &str) {
        let Some(service) = self.service.upgrade() else {
            return;
        };
        {
            let mut status = service.status.borrow_mut();
            if !status
                .resync
                .as_ref()
                .is_some_and(|scope| scope.id == self.id)
            {
                return;
            }
            status.resync = None;
        }
        service.record_resync_failure(code);
    }
}
