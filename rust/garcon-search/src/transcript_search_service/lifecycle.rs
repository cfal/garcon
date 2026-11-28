use std::{future::Future, io::ErrorKind, pin::Pin, rc::Rc, time::Duration};

use garcon_contract::chat_search::TranscriptSearchPhase;
use serde_json::json;
use tokio::time::{Instant, sleep};
use tokio_util::sync::CancellationToken;

use crate::worker_protocol::IndexerEvent;

use super::{
    CLOSE_TIMEOUT, REQUEST_TIMEOUT, SearchResult, SearchServiceError, TranscriptSearchService,
    cancelled, milliseconds,
};

const RESTART_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(5),
    Duration::from_secs(30),
];
const HEALTHY_RESET: Duration = Duration::from_secs(30);

#[derive(Clone, Copy)]
enum Role {
    Indexer,
    Reader(usize),
}

impl Role {
    fn restart_code(self) -> &'static str {
        match self {
            Self::Indexer => "SEARCH_INDEXER_RESTARTED",
            Self::Reader(_) => "SEARCH_READER_RESTARTED",
        }
    }

    fn failure_code(self) -> &'static str {
        match self {
            Self::Indexer => "SEARCH_INDEXER_RESTART_FAILED",
            Self::Reader(_) => "SEARCH_READER_RESTART_FAILED",
        }
    }
}

type WorkerExit = Pin<Box<dyn Future<Output = ()>>>;

impl TranscriptSearchService {
    pub async fn enable(self: &Rc<Self>, signal: &CancellationToken) -> SearchResult<()> {
        let _lifecycle = self.lifecycle.lock().await;
        if self.closed.get() {
            return Err(SearchServiceError::Closed);
        }
        if self.enabled.get() {
            return Ok(());
        }
        cancelled(signal)?;
        let started = Instant::now();
        let mut directory = tokio::fs::DirBuilder::new();
        directory.recursive(true);
        #[cfg(unix)]
        directory.mode(0o700);
        directory.create(&self.search_directory).await?;

        self.phase_override
            .set(Some(TranscriptSearchPhase::Opening));
        self.note_status();
        let opened = async {
            let recreated = self.admit(Role::Indexer, signal).await?;
            for index in 0..self.readers.slots.len() {
                self.admit(Role::Reader(index), signal).await?;
            }
            Ok::<_, SearchServiceError>(recreated)
        }
        .await;
        match opened {
            Ok(recreated) => {
                self.lifetime.replace(CancellationToken::new()).cancel();
                self.enabled.set(true);
                self.phase_override.set(None);
                self.set_last_error(None);
                self.watch(Role::Indexer);
                for index in 0..self.readers.slots.len() {
                    self.watch(Role::Reader(index));
                }
                self.note_durable();
                self.logger.info(
                    "Transcript search enabled",
                    Some(&Self::log_fields(
                        "SEARCH_ENABLED",
                        [
                            (
                                "openMs",
                                json!(milliseconds(started.elapsed()).round() as u64),
                            ),
                            ("recreated", json!(recreated)),
                        ],
                    )),
                );
                Ok(())
            }
            Err(error) => {
                self.phase_override.set(Some(TranscriptSearchPhase::Failed));
                self.set_last_error(Some("SEARCH_INDEX_ADMISSION_FAILED".into()));
                self.stop_workers().await;
                self.note_status();
                Err(error)
            }
        }
    }

    pub async fn disable_and_delete(
        self: &Rc<Self>,
        signal: &CancellationToken,
    ) -> SearchResult<()> {
        let _lifecycle = self.lifecycle.lock().await;
        self.enabled.set(false);
        self.lifecycle_token().cancel();
        self.reject_ingest();
        self.reject_readers();
        self.stop_workers().await;
        cancelled(signal)?;
        match tokio::fs::remove_dir_all(&self.search_directory).await {
            Err(error) if error.kind() != ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        self.reset_status();
        self.note_status();
        Ok(())
    }

    pub async fn close(self: &Rc<Self>) {
        let _lifecycle = self.lifecycle.lock().await;
        if self.closed.replace(true) {
            return;
        }
        self.enabled.set(false);
        self.lifecycle_token().cancel();
        self.reject_ingest();
        self.reject_readers();
        self.clear_status_timers();
        self.stop_workers().await;
    }

    async fn admit(self: &Rc<Self>, role: Role, signal: &CancellationToken) -> SearchResult<bool> {
        match role {
            Role::Indexer => {
                let event = self
                    .indexer
                    .start(self.db_path.clone(), Some(signal), REQUEST_TIMEOUT)
                    .await?;
                let IndexerEvent::Opened { recreated } = event else {
                    return Err(SearchServiceError::InvalidResponse);
                };
                self.clear_counts_retry();
                Ok(recreated)
            }
            Role::Reader(index) => {
                self.readers.slots[index]
                    .worker
                    .start(self.db_path.clone(), Some(signal), REQUEST_TIMEOUT)
                    .await?;
                self.reader_admitted(index);
                Ok(false)
            }
        }
    }

    fn worker_exit(&self, role: Role) -> Option<WorkerExit> {
        match role {
            Role::Indexer => {
                let worker = self.indexer.current_worker()?;
                Some(Box::pin(async move {
                    let _ = worker.wait_closed().await;
                }))
            }
            Role::Reader(index) => {
                let worker = self.readers.slots[index].worker.current_worker()?;
                Some(Box::pin(async move {
                    let _ = worker.wait_closed().await;
                }))
            }
        }
    }

    fn watch(self: &Rc<Self>, role: Role) {
        let Some(mut exited) = self.worker_exit(role) else {
            return;
        };
        let weak = Rc::downgrade(self);
        let life = self.lifecycle_token();
        tokio::task::spawn_local(async move {
            let mut admitted_at = Instant::now();
            let mut attempt = 0_usize;
            loop {
                tokio::select! { biased;
                    () = life.cancelled() => return,
                    () = exited => {},
                }
                if admitted_at.elapsed() >= HEALTHY_RESET {
                    attempt = 0;
                }
                let Some(service) = weak.upgrade() else {
                    return;
                };
                if let Role::Reader(index) = role {
                    service.quarantine_reader(index);
                }
                service.note_status();
                drop(service);
                loop {
                    let delay = RESTART_DELAYS[attempt.min(RESTART_DELAYS.len() - 1)];
                    attempt = attempt.saturating_add(1);
                    tokio::select! { biased;
                        () = life.cancelled() => return,
                        () = sleep(delay) => {},
                    }
                    let Some(service) = weak.upgrade() else {
                        return;
                    };
                    if !service.running() {
                        return;
                    }
                    let recreated = match service.admit(role, &life).await {
                        Ok(recreated) => recreated,
                        Err(_) if life.is_cancelled() => return,
                        Err(_) => {
                            service.logger.warn(
                                "Transcript search worker restart failed.",
                                Some(&Self::log_fields(role.failure_code(), [])),
                            );
                            if let Some(exit) = service.worker_exit(role) {
                                tokio::select! { biased;
                                    () = life.cancelled() => return,
                                    () = exit => {},
                                }
                            }
                            continue;
                        }
                    };
                    service.logger.warn(
                        "Transcript search worker restarted.",
                        Some(&Self::log_fields(role.restart_code(), [])),
                    );
                    service.note_status();
                    if matches!(role, Role::Indexer) {
                        if recreated {
                            for index in 0..service.readers.slots.len() {
                                service.quarantine_reader(index);
                            }
                            service.note_durable();
                        }
                        let handler = service.resync_handler.borrow().clone();
                        if let Some(handler) = handler {
                            let result = tokio::select! { biased;
                                () = life.cancelled() => return,
                                result = handler() => result,
                            };
                            if result.is_err() {
                                service.logger.warn(
                                    "Transcript search worker restart failed.",
                                    Some(&Self::log_fields(role.failure_code(), [])),
                                );
                            }
                        }
                    }
                    let Some(next) = service.worker_exit(role) else {
                        if life.is_cancelled() {
                            return;
                        }
                        continue;
                    };
                    admitted_at = Instant::now();
                    exited = next;
                    break;
                }
            }
        });
    }

    async fn stop_workers(&self) {
        let [first, second] = &self.readers.slots;
        let _ = tokio::join!(
            first.worker.stop(CLOSE_TIMEOUT),
            second.worker.stop(CLOSE_TIMEOUT),
            self.indexer.stop(CLOSE_TIMEOUT)
        );
        self.reset_reader_slots();
    }
}
