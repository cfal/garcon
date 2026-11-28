//! Derived chat previews. A persisted entry is visible only after its ledger
//! view and content identity have been checked.

pub mod ledger_transcript_source;
mod preview;

use std::{
    cell::{Cell, RefCell},
    collections::HashSet,
    error::Error,
    io,
    path::{Path, PathBuf},
    pin::pin,
    rc::Rc,
    time::Duration,
};

use async_trait::async_trait;
use futures::{Stream, StreamExt};
use garcon_base::{
    event_loop::{EventLoopSteps, yield_to_event_loop},
    json_file_store::{JsonFileStore, JsonWriteOptions},
    log::{Logger, create_logger},
    stored_json::parse_stored_json,
};
use garcon_contract::{chat_activity::ChatRunOutcome, chat_id::ChatId, chat_types::ChatMessage};
use garcon_js::{Clock, InvalidTimeValue, SystemClock, to_iso_string, utf16};
use indexmap::IndexMap;
use serde::Serialize;
use tokio::sync::{Mutex, oneshot};
use tokio_util::sync::CancellationToken;

use crate::{
    carryover::segments::carry_over_revision,
    chat_activity_outcomes::{ActivityOutcomeAttempt, ChatActivityOutcomes},
    registry_contracts::ChatRegistryEntry,
    store::{ChatRegistry, RegistryEvent},
};

use preview::{
    first_preview, last_preview, latest_timestamp, normalize_persisted, text, timestamp,
};

const METADATA_VERSION: u64 = 1;
const METADATA_FILE: &str = "chat-metadata.json";

type BoxError = Box<dyn Error>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMetadataIdentity {
    pub carry_over_revision: String,
    pub agent_ownership_epoch: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MetadataSource {
    Live,
    AgentPreview,
    Startup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMetadata {
    pub chat_id: String,
    pub transcript_view_id: Option<String>,
    pub created_at: Option<String>,
    pub last_activity: Option<String>,
    pub last_message: String,
    pub first_message: String,
    pub source: MetadataSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<ChatMetadataIdentity>,
}

pub struct AgentPreviewMetadata {
    pub created_at: Option<String>,
    pub last_activity: Option<String>,
    pub last_message: Option<String>,
    pub first_message: String,
}

/// A view exists, but might not yet have a usable preview.
pub struct ExistingTranscriptPreview {
    pub preview: Option<AgentPreviewMetadata>,
}

pub trait MetadataTranscriptSource {
    fn existing_view_id(&self, chat_id: &ChatId) -> Result<Option<String>, BoxError>;

    fn existing_preview(
        &self,
        session: &ChatRegistryEntry,
        chat_id: &ChatId,
    ) -> Result<Option<ExistingTranscriptPreview>, BoxError>;
}

#[async_trait(?Send)]
pub trait MetadataOutcomeReader {
    async fn read_run_outcome(
        &self,
        chat_id: &ChatId,
        transcript_view_id: &str,
    ) -> Result<Option<ChatRunOutcome>, BoxError>;
}

#[derive(Serialize)]
pub struct MetadataSnapshot {
    version: u64,
    chats: IndexMap<String, ChatMetadata>,
}

#[async_trait(?Send)]
pub trait MetadataWriter {
    async fn write(&self, path: &Path, snapshot: &MetadataSnapshot) -> Result<(), BoxError>;
}

#[async_trait(?Send)]
impl MetadataWriter for JsonFileStore {
    async fn write(&self, path: &Path, snapshot: &MetadataSnapshot) -> Result<(), BoxError> {
        self.write_json_file_atomic(
            &path.to_string_lossy(),
            snapshot,
            JsonWriteOptions {
                mode: Some(0o600),
                trailing_newline: None,
            },
        )
        .await?;
        Ok(())
    }
}

pub struct MetadataIndexOptions {
    pub path: Option<PathBuf>,
    pub save_delay: Duration,
    pub clock: Rc<dyn Clock>,
    pub outcome_reader: Option<Rc<dyn MetadataOutcomeReader>>,
    pub writer: Rc<dyn MetadataWriter>,
}

impl Default for MetadataIndexOptions {
    fn default() -> Self {
        Self {
            path: None,
            save_delay: Duration::from_secs(1),
            clock: Rc::new(SystemClock),
            outcome_reader: None,
            writer: Rc::new(JsonFileStore::default()),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MetadataError {
    #[error("Chat with ID {0} already exists")]
    Duplicate(ChatId),
    #[error(transparent)]
    Clock(#[from] InvalidTimeValue),
    #[error(transparent)]
    Transcript(BoxError),
}

pub struct MetadataIndex {
    registry: Rc<ChatRegistry>,
    transcripts: Rc<dyn MetadataTranscriptSource>,
    options: MetadataIndexOptions,
    outcomes: ChatActivityOutcomes,
    entries: RefCell<IndexMap<String, ChatMetadata>>,
    validated: RefCell<HashSet<String>>,
    closed: Cell<bool>,
    repair_waiters: RefCell<Option<Vec<oneshot::Sender<()>>>>,
    save_timer: RefCell<Option<CancellationToken>>,
    write_lock: Mutex<()>,
}

impl MetadataIndex {
    pub async fn open(
        registry: Rc<ChatRegistry>,
        transcripts: Rc<dyn MetadataTranscriptSource>,
        options: MetadataIndexOptions,
    ) -> Rc<Self> {
        let source = transcripts.clone();
        let outcomes = ChatActivityOutcomes::new(move |chat_id| {
            source.existing_view_id(chat_id).unwrap_or_else(|error| {
                warn(&format!(
                    "metadata: activity view unavailable for {chat_id}: {error}"
                ));
                None
            })
        });
        let entries = load_persisted(options.path.as_deref()).await;
        let mut entries = entries;
        entries.retain(|id, _| registry.has_chat(id));
        let index = Rc::new(Self {
            registry,
            transcripts,
            options,
            outcomes,
            entries: RefCell::new(entries),
            validated: RefCell::new(HashSet::new()),
            closed: Cell::new(false),
            repair_waiters: RefCell::new(None),
            save_timer: RefCell::new(None),
            write_lock: Mutex::new(()),
        });
        let weak = Rc::downgrade(&index);
        index.registry.subscribe(Rc::new(move |event| {
            if let RegistryEvent::ChatRemoved(id, _) = event
                && let Some(index) = weak.upgrade()
            {
                index.entries.borrow_mut().shift_remove(id.as_str());
                index.validated.borrow_mut().remove(id.as_str());
                index.outcomes.delete(id);
                index.schedule_save();
            }
            Ok(())
        }));
        index.schedule_save();
        index
    }

    pub fn get_chat_metadata(&self, chat_id: &ChatId) -> Option<ChatMetadata> {
        if !self.validated.borrow().contains(chat_id.as_str()) {
            return None;
        }
        self.entries.borrow().get(chat_id.as_str()).cloned()
    }

    pub fn list_all_chat_metadata(&self) -> IndexMap<String, ChatMetadata> {
        let entries = self.entries.borrow();
        let validated = self.validated.borrow();
        entries
            .iter()
            .filter(|(id, _)| validated.contains(*id))
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect()
    }

    pub fn invalidate_transcript_view(&self, chat_id: &ChatId) {
        self.validated.borrow_mut().remove(chat_id.as_str());
        self.outcomes.invalidate_view(chat_id);
    }

    pub fn get_run_outcome(&self, chat_id: &ChatId) -> Option<ChatRunOutcome> {
        self.outcomes.get(chat_id)
    }

    pub fn clear_run_outcome(&self, chat_id: &ChatId, run_id: Option<&str>) {
        self.outcomes.clear(chat_id, run_id);
    }

    pub fn begin_run_attempt(&self, chat_id: &ChatId, run_id: &str) {
        self.outcomes.begin(chat_id, run_id);
    }

    pub fn delete_chat_activity(&self, chat_id: &ChatId) {
        self.outcomes.delete(chat_id);
    }

    pub fn capture_failure_attempt(
        &self,
        chat_id: &ChatId,
        run_id: Option<&str>,
    ) -> Option<ActivityOutcomeAttempt> {
        self.outcomes.capture_failure(chat_id, run_id)
    }

    pub fn record_failed_attempt(&self, attempt: Option<&ActivityOutcomeAttempt>) -> bool {
        self.outcomes.fail(attempt)
    }

    pub fn capture_committed_outcome(
        &self,
        chat_id: &ChatId,
        view_id: &str,
        run_id: &str,
    ) -> Option<ActivityOutcomeAttempt> {
        self.outcomes.capture_terminal(chat_id, view_id, run_id)
    }

    pub fn record_committed_outcome(
        &self,
        attempt: Option<&ActivityOutcomeAttempt>,
        outcome: ChatRunOutcome,
    ) -> bool {
        self.outcomes.commit(attempt, outcome)
    }

    pub async fn prepare_run_outcome_repair(
        self: &Rc<Self>,
        chat_id: &ChatId,
    ) -> Option<impl FnOnce() -> bool + use<>> {
        if self.closed.get() || !self.registry.has_chat(chat_id) {
            return None;
        }
        let reader = self.options.outcome_reader.as_ref()?;
        let attempt = self.outcomes.capture_repair(chat_id)?;
        let outcome = match reader.read_run_outcome(chat_id, attempt.view_id()).await {
            Ok(outcome) => outcome,
            Err(error) => {
                warn(&format!(
                    "metadata: failed to repair run outcome for {chat_id}: {error}"
                ));
                return None;
            }
        };
        let index = self.clone();
        let chat_id = chat_id.clone();
        Some(move || {
            !index.closed.get()
                && index.registry.has_chat(&chat_id)
                && index.outcomes.restore(&attempt, outcome)
        })
    }

    pub async fn repair(self: &Rc<Self>) {
        if self.closed.get() {
            return;
        }
        let (sender, receiver) = oneshot::channel();
        let start = {
            let mut pending = self.repair_waiters.borrow_mut();
            let start = pending.is_none();
            pending.get_or_insert_with(Vec::new).push(sender);
            start
        };
        if start {
            let index = self.clone();
            tokio::task::spawn_local(async move {
                index.repair_from_transcripts().await;
                if let Some(waiters) = index.repair_waiters.borrow_mut().take() {
                    for waiter in waiters {
                        let _ = waiter.send(());
                    }
                }
            });
        }
        let _ = receiver.await;
    }

    pub async fn close(&self) {
        self.closed.set(true);
        let (sender, receiver) = oneshot::channel();
        if let Some(waiters) = self.repair_waiters.borrow_mut().as_mut() {
            waiters.push(sender);
        } else {
            return;
        }
        let _ = receiver.await;
    }

    async fn repair_from_transcripts(self: &Rc<Self>) {
        let ids = self.registry.list_chat_ids();
        for chat_id in &ids {
            yield_to_event_loop().await;
            if self.closed.get() {
                return;
            }
            if let Some(session) = self.registry.get_chat(chat_id) {
                self.repair_chat_metadata(chat_id, &session);
            }
        }
        // A ledger outcome scan must not delay bounded preview reads for other chats.
        for chat_id in &ids {
            yield_to_event_loop().await;
            if self.closed.get() {
                return;
            }
            if let Some(publish) = self.prepare_run_outcome_repair(chat_id).await {
                publish();
            }
        }
    }

    fn repair_chat_metadata(
        self: &Rc<Self>,
        chat_id: &ChatId,
        session: &ChatRegistryEntry,
    ) -> Option<ChatMetadata> {
        match self.repair_chat(chat_id, session) {
            Ok(entry) => entry,
            Err(error) => {
                warn(&format!(
                    "metadata: failed to build metadata for {chat_id}: {error}"
                ));
                None
            }
        }
    }

    fn repair_chat(
        self: &Rc<Self>,
        chat_id: &ChatId,
        session: &ChatRegistryEntry,
    ) -> Result<Option<ChatMetadata>, BoxError> {
        let existing = self.entries.borrow().get(chat_id.as_str()).cloned();
        if let Some(existing) = existing.filter(|entry| !entry.first_message.is_empty()) {
            let view = self.transcripts.existing_view_id(chat_id)?;
            let same_view = view
                .filter(|id| !id.is_empty())
                .is_none_or(|view| Some(view) == existing.transcript_view_id);
            if same_view
                && existing.identity.as_ref().is_none_or(|identity| {
                    identity.agent_ownership_epoch == session.agent_ownership_epoch
                        && identity.carry_over_revision == revision(session)
                })
            {
                self.validated.borrow_mut().insert(chat_id.to_string());
                return Ok(Some(existing));
            }
        }
        let transcript_view_id = self.transcripts.existing_view_id(chat_id)?;
        let Some(result) = self.transcripts.existing_preview(session, chat_id)? else {
            return Ok(None);
        };
        let preview = result.preview.as_ref();
        let first_message =
            first_preview(preview.map_or("", |preview| preview.first_message.as_str()));
        let created_at = preview.and_then(|preview| nonempty(preview.created_at.as_deref()));
        let last_activity = preview
            .and_then(|preview| nonempty(preview.last_activity.as_deref()))
            .or(created_at);
        let entry = ChatMetadata {
            chat_id: chat_id.to_string(),
            transcript_view_id,
            created_at: created_at.map(str::to_owned),
            last_activity: last_activity.map(str::to_owned),
            last_message: last_preview(
                preview
                    .and_then(|preview| nonempty(preview.last_message.as_deref()))
                    .unwrap_or(&first_message),
            ),
            first_message,
            source: MetadataSource::AgentPreview,
            identity: Some(ChatMetadataIdentity {
                carry_over_revision: revision(session),
                agent_ownership_epoch: session.agent_ownership_epoch.clone(),
            }),
        };
        self.publish(chat_id, entry.clone());
        Ok(Some(entry))
    }

    pub fn update_from_appended_messages(
        self: &Rc<Self>,
        chat_id: &ChatId,
        transcript_view_id: &str,
        messages: &[ChatMessage],
        identity: Option<ChatMetadataIdentity>,
    ) -> Result<(), MetadataError> {
        if self.view(chat_id)?.as_deref() != Some(transcript_view_id) {
            return Ok(());
        }
        let cached = self.entries.borrow().get(chat_id.as_str()).cloned();
        let current = if cached.is_some() && !self.validated.borrow().contains(chat_id.as_str()) {
            let Some(session) = self.registry.get_chat(chat_id) else {
                return Ok(());
            };
            let Some(entry) = self.repair_chat_metadata(chat_id, &session) else {
                return Ok(());
            };
            Some(entry)
        } else {
            cached.filter(|entry| entry.transcript_view_id.as_deref() == Some(transcript_view_id))
        };
        let created_at = self.or_now(
            current
                .as_ref()
                .and_then(|entry| entry.created_at.as_deref())
                .or_else(|| messages.first().map(timestamp)),
        )?;
        let first_message = nonempty(current.as_ref().map(|entry| entry.first_message.as_str()))
            .map_or_else(
                || {
                    first_preview(
                        messages
                            .iter()
                            .find_map(|message| match message {
                                ChatMessage::User(message) => nonempty(Some(&message.content)),
                                _ => None,
                            })
                            .unwrap_or_default(),
                    )
                },
                str::to_owned,
            );
        let last_message = last_preview(
            messages
                .iter()
                .rev()
                .find_map(|message| nonempty(Some(text(message))))
                .or_else(|| current.as_ref().map(|entry| entry.last_message.as_str()))
                .unwrap_or(&first_message),
        );
        let last_activity = latest_timestamp(messages)
            .or_else(|| {
                current
                    .as_ref()
                    .and_then(|entry| entry.last_activity.as_deref())
            })
            .unwrap_or(&created_at)
            .to_owned();
        self.publish(
            chat_id,
            ChatMetadata {
                chat_id: chat_id.to_string(),
                transcript_view_id: Some(transcript_view_id.into()),
                created_at: Some(created_at),
                last_activity: Some(last_activity),
                last_message,
                first_message,
                source: MetadataSource::Live,
                identity: identity.or_else(|| current.and_then(|entry| entry.identity)),
            },
        );
        Ok(())
    }

    pub async fn replace_from_transcript_view(
        self: &Rc<Self>,
        chat_id: &ChatId,
        transcript_view_id: &str,
        pages: impl Stream<Item = Result<Vec<ChatMessage>, BoxError>>,
    ) -> Result<(), MetadataError> {
        let mut pages = pin!(pages);
        let mut steps = EventLoopSteps::new("replacement-metadata");
        let mut first_message = String::new();
        let mut first_at = None;
        let mut last_text = None;
        let mut last_at = None;
        while let Some(page) = pages.next().await {
            for message in page.map_err(MetadataError::Transcript)? {
                let text = text(&message);
                if first_message.is_empty() && matches!(message, ChatMessage::User(_)) {
                    first_message = first_preview(text);
                }
                if !text.is_empty() {
                    last_text = Some(last_preview(text));
                }
                let timestamp = timestamp(&message);
                if first_at.is_none() {
                    first_at = Some(timestamp.to_owned());
                }
                if last_at
                    .as_deref()
                    .is_none_or(|last: &str| last.is_empty() || utf16::cmp(timestamp, last).is_gt())
                {
                    last_at = Some(timestamp.to_owned());
                }
                if steps.due() {
                    steps.next().await;
                }
            }
        }
        if self.view(chat_id)?.as_deref() != Some(transcript_view_id) {
            return Ok(());
        }
        let current = self.entries.borrow().get(chat_id.as_str()).cloned();
        let created_at = self.or_now(
            current
                .as_ref()
                .and_then(|entry| entry.created_at.as_deref())
                .or(first_at.as_deref()),
        )?;
        self.publish(
            chat_id,
            ChatMetadata {
                chat_id: chat_id.to_string(),
                transcript_view_id: Some(transcript_view_id.into()),
                last_activity: Some(last_at.unwrap_or_else(|| created_at.clone())),
                created_at: Some(created_at),
                last_message: last_text.unwrap_or_else(|| last_preview(&first_message)),
                first_message,
                source: MetadataSource::Live,
                identity: current.and_then(|entry| entry.identity),
            },
        );
        Ok(())
    }

    pub fn add_new_chat_metadata(
        self: &Rc<Self>,
        chat_id: &ChatId,
        first_message: &str,
    ) -> Result<(), MetadataError> {
        if self.entries.borrow().contains_key(chat_id.as_str()) {
            return Err(MetadataError::Duplicate(chat_id.clone()));
        }
        let created_at = self.or_now(None)?;
        self.publish(
            chat_id,
            ChatMetadata {
                chat_id: chat_id.to_string(),
                transcript_view_id: self.view(chat_id)?,
                last_activity: Some(created_at.clone()),
                created_at: Some(created_at),
                last_message: last_preview(first_message),
                first_message: first_preview(first_message),
                source: MetadataSource::Startup,
                identity: None,
            },
        );
        Ok(())
    }

    fn publish(self: &Rc<Self>, chat_id: &ChatId, entry: ChatMetadata) {
        self.entries.borrow_mut().insert(chat_id.to_string(), entry);
        self.validated.borrow_mut().insert(chat_id.to_string());
        self.schedule_save();
    }

    fn view(&self, chat_id: &ChatId) -> Result<Option<String>, MetadataError> {
        self.transcripts
            .existing_view_id(chat_id)
            .map_err(MetadataError::Transcript)
    }

    fn or_now(&self, timestamp: Option<&str>) -> Result<String, InvalidTimeValue> {
        timestamp.map_or_else(
            || to_iso_string(self.options.clock.now_ms()),
            |timestamp| Ok(timestamp.into()),
        )
    }

    fn schedule_save(self: &Rc<Self>) {
        if self.options.path.is_none() {
            return;
        }
        let cancel = CancellationToken::new();
        if let Some(previous) = self.save_timer.replace(Some(cancel.clone())) {
            previous.cancel();
        }
        let index = Rc::downgrade(self);
        let delay = self.options.save_delay;
        tokio::task::spawn_local(async move {
            tokio::select! {
                biased;
                () = cancel.cancelled() => {},
                () = tokio::time::sleep(delay) => {
                    let Some(index) = index.upgrade() else { return; };
                    index.save_timer.borrow_mut().take();
                    if let Err(error) = index.save().await {
                        warn(&format!("metadata: failed to save chat metadata: {error}"));
                    }
                }
            }
        });
    }

    pub async fn flush(self: &Rc<Self>) -> Result<(), BoxError> {
        if let Some(timer) = self.save_timer.borrow_mut().take() {
            timer.cancel();
        }
        let index = self.clone();
        tokio::task::spawn_local(async move { index.save().await }).await?
    }

    async fn save(&self) -> Result<(), BoxError> {
        let Some(path) = &self.options.path else {
            return Ok(());
        };
        let _lock = self.write_lock.lock().await;
        let snapshot = MetadataSnapshot {
            version: METADATA_VERSION,
            chats: self.entries.borrow().clone(),
        };
        self.options.writer.write(path, &snapshot).await
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

fn revision(session: &ChatRegistryEntry) -> String {
    carry_over_revision(
        &session.carry_over_segments,
        session.carry_over_migration_quarantine.as_ref(),
    )
}

fn warn(message: &str) {
    create_logger("chats:metadata-store").warn(message);
}

async fn load_persisted(path: Option<&Path>) -> IndexMap<String, ChatMetadata> {
    let Some(path) = path else {
        return IndexMap::new();
    };
    let raw = match tokio::fs::read(path).await {
        Ok(raw) => raw,
        Err(error) => {
            if error.kind() != io::ErrorKind::NotFound {
                warn(&format!("metadata: failed to load chat metadata: {error}"));
            }
            return IndexMap::new();
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) =
            tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await
        {
            warn(&format!(
                "metadata: failed to repair chat-metadata.json permissions: {error}"
            ));
        }
    }
    let parsed = match parse_stored_json(&String::from_utf8_lossy(&raw), METADATA_FILE) {
        Ok(parsed) => parsed,
        Err(error) => {
            warn(&format!("metadata: failed to load chat metadata: {error}"));
            return IndexMap::new();
        }
    };
    parsed
        .get("chats")
        .and_then(serde_json::Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(id, raw)| normalize_persisted(id, raw).map(|entry| (id.clone(), entry)))
        .collect()
}
