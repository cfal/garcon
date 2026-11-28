//! Ports `server/controller/chats/carryover/transcript-store.ts`.

use std::{
    cell::RefCell,
    error::Error,
    io,
    path::{Path, PathBuf},
    rc::Rc,
};

use garcon_base::{
    domain_error::{DomainError, as_domain_error},
    errors::{DiagnosticError, ErrorMetadata},
    json_file_store::{WriteFileError, sync_directory},
    keyed_lock::LockAborted,
    stored_json::MalformedStoredJsonError,
};
use garcon_contract::{chat_types::ChatMessage, error_codes::ErrorCode};
use garcon_js::{Clock, SystemClock};
use indexmap::{IndexMap, IndexSet};
use tokio::{fs, sync::Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::registry_contracts::{CarryOverMigrationQuarantine, CarryOverSegmentRef};

use super::{
    page_codec::CarryOverPageCodecError,
    segment_types::{CarryOverSegmentIndex, CarryOverSegmentIndexError, SeedSanitationOutcome},
    segments::{CarryOverSegmentBindingError, archived_logical_count, carry_over_revision},
};

mod reads;
mod writes;

pub use writes::PreparedCarryOverSegment;

const DEFAULT_INDEX_CACHE_SIZE: usize = 256;

#[derive(Debug, thiserror::Error)]
#[error("Carryover segment {id} already exists with different content")]
pub struct CarryOverTranscriptCollision {
    id: String,
    #[source]
    cause: Box<dyn Error>,
}

impl DiagnosticError for CarryOverTranscriptCollision {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "CarryOverTranscriptError",
            code: Some("CARRYOVER_SEGMENT_COLLISION"),
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error(transparent)]
pub struct CarryOverHistoryUnavailableError(DomainError);

impl CarryOverHistoryUnavailableError {
    fn new(cause: impl Into<Box<dyn Error>>) -> Self {
        Self(
            DomainError::new(
                ErrorCode::CARRYOVER_HISTORY_UNAVAILABLE,
                "Archived chat history is unavailable.",
                422,
                false,
            )
            .with_cause(cause.into()),
        )
    }

    pub fn domain_error(&self) -> &DomainError {
        &self.0
    }
}

impl DiagnosticError for CarryOverHistoryUnavailableError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "CarryOverHistoryUnavailableError",
            code: Some(self.0.code.as_str()),
        }
    }
}

pub fn as_carry_over_domain_error<'a>(error: &'a (dyn Error + 'static)) -> Option<&'a DomainError> {
    if let Some(archive) = error.downcast_ref::<CarryOverHistoryUnavailableError>() {
        return Some(archive.domain_error());
    }
    if let Some(CarryOverStoreError::Unavailable(archive)) =
        error.downcast_ref::<CarryOverStoreError>()
    {
        return Some(archive.domain_error());
    }
    as_domain_error(error)
}

#[derive(Debug, thiserror::Error)]
pub enum CarryOverStoreError {
    #[error(transparent)]
    Aborted(#[from] LockAborted),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Collision(#[from] CarryOverTranscriptCollision),
    #[error(transparent)]
    Unavailable(#[from] CarryOverHistoryUnavailableError),
    #[error(transparent)]
    Binding(#[from] CarryOverSegmentBindingError),
    #[error(transparent)]
    InvalidIndex(#[from] CarryOverSegmentIndexError),
    #[error(transparent)]
    InvalidJson(#[from] MalformedStoredJsonError),
    #[error(transparent)]
    Write(#[from] WriteFileError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Worker(#[from] tokio::task::JoinError),
    #[error(transparent)]
    Page(CarryOverPageCodecError),
    #[error("Carryover segment ID must be a lowercase UUID")]
    InvalidSegmentId,
    #[error("Carryover segment must contain at least one message")]
    EmptySegment,
    #[error("Carryover stream batch size must be positive")]
    InvalidBatchSize,
}

impl From<CarryOverPageCodecError> for CarryOverStoreError {
    fn from(error: CarryOverPageCodecError) -> Self {
        match error {
            CarryOverPageCodecError::Aborted(error) => Self::Aborted(error),
            CarryOverPageCodecError::Io(error) => Self::Io(error),
            other => Self::Page(other),
        }
    }
}

impl CarryOverStoreError {
    fn unavailable(self) -> Self {
        match self {
            Self::Aborted(_) | Self::Unavailable(_) => self,
            cause => CarryOverHistoryUnavailableError::new(cause).into(),
        }
    }
}

pub struct PrepareCarryOverSegmentRequest<'a> {
    pub operation_id: &'a str,
    pub id: &'a str,
    pub seed_sanitation: SeedSanitationOutcome,
    pub messages: Vec<ChatMessage>,
    pub signal: Option<&'a CancellationToken>,
}

pub struct CarryOverTranscriptPage {
    pub messages: Vec<ChatMessage>,
    pub total: u64,
    pub offset: u64,
    pub limit: u64,
    pub has_more: bool,
    pub revision: String,
}

pub struct CarryOverSweepResult {
    pub reachable_segment_count: usize,
    pub unreachable_segment_count: usize,
    pub removed_segment_count: usize,
    pub compressed_bytes: u128,
    pub declared_uncompressed_bytes: u128,
    pub duration_ms: i64,
}

pub struct CarryOverTranscriptStoreOptions {
    pub index_cache_size: usize,
    pub clock: Rc<dyn Clock>,
    pub uuid: Rc<dyn Fn() -> Uuid>,
}

impl Default for CarryOverTranscriptStoreOptions {
    fn default() -> Self {
        Self {
            index_cache_size: DEFAULT_INDEX_CACHE_SIZE,
            clock: Rc::new(SystemClock),
            uuid: Rc::new(Uuid::new_v4),
        }
    }
}

#[derive(Clone)]
pub struct CarryOverTranscriptStore(Rc<Store>);

struct Store {
    root_dir: PathBuf,
    segments_dir: PathBuf,
    tmp_dir: PathBuf,
    trash_dir: PathBuf,
    options: CarryOverTranscriptStoreOptions,
    index_cache: RefCell<IndexMap<String, Rc<CarryOverSegmentIndex>>>,
    degraded_segments: RefCell<IndexSet<String>>,
    writer_root_counts: RefCell<IndexMap<String, usize>>,
    root_state_lock: Mutex<()>,
    pending_releases: RefCell<Vec<String>>,
}

impl CarryOverTranscriptStore {
    pub fn new(workspace_dir: &Path, options: CarryOverTranscriptStoreOptions) -> Self {
        let root_dir = workspace_dir.join("carryover-transcripts");
        Self(Rc::new(Store {
            segments_dir: root_dir.join("segments"),
            tmp_dir: root_dir.join("tmp"),
            trash_dir: root_dir.join("trash"),
            root_dir,
            options,
            index_cache: RefCell::default(),
            degraded_segments: RefCell::default(),
            writer_root_counts: RefCell::default(),
            root_state_lock: Mutex::new(()),
            pending_releases: RefCell::default(),
        }))
    }

    pub async fn initialize(&self) -> io::Result<()> {
        let quarantine = self.0.root_dir.join("quarantine");
        tokio::try_join!(
            create_dir(&self.0.segments_dir),
            create_dir(&self.0.tmp_dir),
            create_dir(&self.0.trash_dir),
            create_dir(&quarantine),
        )?;
        let mut entries = fs::read_dir(&self.0.trash_dir).await?;
        let mut removed = false;
        while let Some(entry) = entries.next_entry().await? {
            if entry.file_type().await?.is_dir() {
                remove_dir(&entry.path()).await?;
            } else if let Err(error) = fs::remove_file(entry.path()).await
                && error.kind() != io::ErrorKind::NotFound
            {
                return Err(error);
            }
            removed = true;
        }
        if removed {
            sync_directory(&self.0.trash_dir).await?;
        }
        Ok(())
    }

    pub fn revision(
        &self,
        refs: &[CarryOverSegmentRef],
        quarantine: Option<&CarryOverMigrationQuarantine>,
    ) -> String {
        carry_over_revision(refs, quarantine)
    }

    pub fn logical_message_count(&self, refs: &[CarryOverSegmentRef]) -> u64 {
        archived_logical_count(refs)
    }

    pub fn writer_roots(&self) -> IndexSet<String> {
        self.0.writer_root_counts.borrow().keys().cloned().collect()
    }

    fn segment_dir(&self, id: &str) -> PathBuf {
        self.0.segments_dir.join(id)
    }

    fn remove_cached(&self, id: &str) {
        self.0.index_cache.borrow_mut().shift_remove(id);
        self.0.degraded_segments.borrow_mut().shift_remove(id);
    }
}

async fn create_dir(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path).await
}

async fn remove_dir(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path).await {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}
