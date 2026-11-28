//! Provider-neutral search service. SQLite and transcript-sized work stay on the worker threads.

mod ingest;
mod lifecycle;
mod readers;
mod status;

#[cfg(test)]
mod tests;

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    error::Error,
    future::Future,
    path::PathBuf,
    pin::Pin,
    rc::Rc,
    time::Duration,
};

use garcon_contract::chat_search::{TranscriptSearchPhase, TranscriptSearchQueryStatsV1};
use garcon_interface::host::AgentLogger;
use garcon_js::{Clock, SystemClock, json::Opaque};
use indexmap::IndexMap;
use serde_json::Value;
use tokio::{sync::Mutex, time::Instant};
use tokio_util::sync::CancellationToken;

use crate::{
    indexer::{IndexerSlot, indexer_slot},
    query_latency_stats::QueryLatencyStats,
    worker_protocol::WorkerFailure,
    worker_supervisor::{WorkerError, WorkerSlotError},
};

pub use ingest::{SearchFrameSource, TranscriptSearchSyncFrame, TranscriptSearchSyncRequest};
pub use readers::TranscriptSearchRequest;
pub use status::{SearchStatusListener, SearchStatusSubscription, TranscriptSearchResyncScope};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

pub type SearchResult<T> = Result<T, SearchServiceError>;
pub type ResyncHandler = Rc<dyn Fn() -> Pin<Box<dyn Future<Output = SearchResult<()>>>>>;

#[derive(Debug, thiserror::Error)]
pub enum SearchServiceError {
    #[error("Transcript search service is closed")]
    Closed,
    #[error("SEARCH_INDEX_UNAVAILABLE")]
    Unavailable,
    #[error("SEARCH_INDEX_BUSY")]
    Busy,
    #[error("SEARCH_TIMEOUT")]
    Timeout,
    #[error("Aborted")]
    Aborted,
    #[error("SEARCH_JOB_CONFLICT")]
    JobConflict,
    #[error("SEARCH_INDEX_INVALID_RESPONSE")]
    InvalidResponse,
    #[error("SEARCH_INDEX_GAP")]
    Gap,
    #[error("SEARCH_RESYNC_INVARIANT")]
    ResyncInvariant,
    #[error(transparent)]
    Failure(#[from] WorkerFailure),
    #[error(transparent)]
    Worker(#[from] WorkerError),
    #[error(transparent)]
    Slot(#[from] WorkerSlotError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Source(Box<dyn Error>),
}

pub struct TranscriptSearchServiceOptions {
    pub workspace_directory: PathBuf,
    pub logger: Rc<dyn AgentLogger>,
    pub reader_request_timeout: Option<Duration>,
}

pub struct TranscriptSearchService {
    search_directory: PathBuf,
    db_path: PathBuf,
    logger: Rc<dyn AgentLogger>,
    clock: Rc<dyn Clock>,
    reader_request_timeout: Duration,
    lifecycle: Mutex<()>,
    lifetime: RefCell<CancellationToken>,
    enabled: Cell<bool>,
    closed: Cell<bool>,
    phase_override: Cell<Option<TranscriptSearchPhase>>,
    indexer: IndexerSlot,
    readers: readers::Readers,
    ingest: RefCell<ingest::Ingest>,
    status: RefCell<status::Status>,
    latency: RefCell<QueryLatencyStats>,
    last_log: RefCell<HashMap<&'static str, Instant>>,
    resync_handler: RefCell<Option<ResyncHandler>>,
}

impl TranscriptSearchService {
    pub fn new(options: TranscriptSearchServiceOptions) -> Rc<Self> {
        Self::with_clock(options, Rc::new(SystemClock))
    }

    pub fn with_clock(options: TranscriptSearchServiceOptions, clock: Rc<dyn Clock>) -> Rc<Self> {
        let search_directory = options.workspace_directory.join("transcript-search");
        Rc::new(Self {
            db_path: search_directory.join("index.sqlite"),
            search_directory,
            logger: options.logger,
            clock,
            reader_request_timeout: options.reader_request_timeout.unwrap_or(REQUEST_TIMEOUT),
            lifecycle: Mutex::new(()),
            lifetime: RefCell::new(CancellationToken::new()),
            enabled: Cell::new(false),
            closed: Cell::new(false),
            phase_override: Cell::new(None),
            indexer: indexer_slot(),
            readers: readers::Readers::new(),
            ingest: RefCell::new(ingest::Ingest::default()),
            status: RefCell::new(status::Status::default()),
            latency: RefCell::new(QueryLatencyStats::default()),
            last_log: RefCell::new(HashMap::new()),
            resync_handler: RefCell::new(None),
        })
    }

    pub fn set_resync_handler(&self, handler: ResyncHandler) {
        self.resync_handler.replace(Some(handler));
    }

    pub fn query_stats(&self) -> TranscriptSearchQueryStatsV1 {
        self.latency.borrow().snapshot()
    }

    fn running(&self) -> bool {
        self.enabled.get() && !self.closed.get()
    }

    fn lifecycle_token(&self) -> CancellationToken {
        self.lifetime.borrow().clone()
    }

    fn log_fields(
        code: &'static str,
        fields: impl IntoIterator<Item = (&'static str, Value)>,
    ) -> IndexMap<String, Opaque> {
        [("code", Value::String(code.into()))]
            .into_iter()
            .chain(fields)
            .map(|(key, value)| (key.into(), Opaque::from_value(value)))
            .collect()
    }

    fn log_allowed(&self, code: &'static str) -> bool {
        let now = Instant::now();
        let mut last = self.last_log.borrow_mut();
        if last
            .get(code)
            .is_some_and(|previous| now - *previous < Duration::from_secs(10))
        {
            return false;
        }
        last.insert(code, now);
        true
    }

    fn warn(
        &self,
        message: &str,
        code: &'static str,
        fields: impl IntoIterator<Item = (&'static str, Value)>,
    ) {
        if self.log_allowed(code) {
            self.logger
                .warn(message, Some(&Self::log_fields(code, fields)));
        }
    }
}

impl Drop for TranscriptSearchService {
    fn drop(&mut self) {
        self.lifetime.get_mut().cancel();
        self.indexer.retire();
        for reader in &self.readers.slots {
            reader.worker.retire();
        }
    }
}

fn cancelled(signal: &CancellationToken) -> SearchResult<()> {
    if signal.is_cancelled() {
        Err(SearchServiceError::Aborted)
    } else {
        Ok(())
    }
}

fn milliseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}
