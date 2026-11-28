//! In-memory authority and persistence for `chats.json`.

mod mutations;

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    error::Error,
    io,
    path::{Path, PathBuf},
    rc::Rc,
    time::Duration,
};

use async_trait::async_trait;
use garcon_base::{
    errors::{DiagnosticError, ErrorMetadata},
    json_file_store::{JsonFileStore, JsonWriteOptions, WriteFileError},
    log::{Logger, create_logger},
    stored_json::parse_stored_json,
};
use garcon_contract::{
    chat_id::ChatId, executors::LOCAL_EXECUTOR_ID, ws_events::ChatProjectPathUpdatedPayload,
};
use garcon_js::OptionalNullable;
use indexmap::IndexMap;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::{
    registry_contracts::{ChatRegistryEntry, ChatRegistrySnapshot},
    registry_entry_codec::{RegistryCodecError, parse_registry},
};

pub use mutations::{
    ChatMutationDurability, ChatRegistryPatch, ChatRegistryProjectPathUpdate, NewChatRegistryEntry,
    PhasedChatUpdate, ReconciledDurability, RegistryDurability, ResolvedChat,
};

pub type RetainReferences =
    Rc<dyn Fn(&[String], &[String]) -> Result<ReferenceLease, Box<dyn Error>>>;
pub type RegistryListener = Rc<dyn Fn(&RegistryEvent) -> Result<(), Box<dyn Error>>>;

pub struct ReferenceLease(Option<Box<dyn FnOnce()>>);

impl ReferenceLease {
    pub fn new(release: impl FnOnce() + 'static) -> Self {
        Self(Some(Box::new(release)))
    }
}

impl Drop for ReferenceLease {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            release();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatRemovalReason {
    UserDeletion,
    StartCompensation,
}

#[derive(Debug, Clone)]
pub enum RegistryEvent {
    ChatAdded(ChatId),
    ChatRemoved(ChatId, ChatRemovalReason),
    ChatReadUpdated(ChatId, OptionalNullable<String>),
    ChatProjectPathUpdated(ChatProjectPathUpdatedPayload),
    ChatTagsUpdated(ChatId),
    ChatParentUpdated(ChatId),
}

#[async_trait(?Send)]
pub trait RegistryWriter {
    async fn write(
        &self,
        path: &Path,
        snapshot: &ChatRegistrySnapshot,
    ) -> Result<(), RegistryWriteFailure>;
}

#[derive(Debug, thiserror::Error)]
#[error("{cause}")]
pub struct RegistryWriteFailure {
    pub renamed: bool,
    #[source]
    pub cause: Box<dyn Error>,
}

#[async_trait(?Send)]
impl RegistryWriter for JsonFileStore {
    async fn write(
        &self,
        path: &Path,
        snapshot: &ChatRegistrySnapshot,
    ) -> Result<(), RegistryWriteFailure> {
        self.write_json_file_atomic(
            &path.to_string_lossy(),
            snapshot,
            JsonWriteOptions {
                mode: Some(0o600),
                trailing_newline: None,
            },
        )
        .await
        .map_err(|error| RegistryWriteFailure {
            renamed: matches!(&error, WriteFileError::Atomic(atomic) if atomic.renamed),
            cause: Box::new(error),
        })
    }
}

pub struct ChatRegistryOptions {
    pub save_delay: Duration,
    pub writer: Rc<dyn RegistryWriter>,
    pub retain_executor_references: Option<RetainReferences>,
    pub retain_provider_references: Option<RetainReferences>,
}

impl Default for ChatRegistryOptions {
    fn default() -> Self {
        Self {
            save_delay: Duration::from_secs(1),
            writer: Rc::new(JsonFileStore::default()),
            retain_executor_references: None,
            retain_provider_references: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    StoredJson(#[from] garcon_base::stored_json::MalformedStoredJsonError),
    #[error(transparent)]
    Codec(#[from] RegistryCodecError),
    #[error(transparent)]
    Write(#[from] RegistryWriteFailure),
    #[error(transparent)]
    Reference(Box<dyn Error>),
    #[error(transparent)]
    Listener(Box<dyn Error>),
    #[error(transparent)]
    Task(#[from] tokio::task::JoinError),
    #[error("{0}")]
    Invalid(String),
    #[error("The chat registry has an unconfirmed save for {0}; reload before further changes.")]
    DurabilityUnknown(ChatId),
    #[error(transparent)]
    Domain(#[from] garcon_base::domain_error::DomainError),
}

impl DiagnosticError for RegistryError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        let name = match self {
            Self::DurabilityUnknown(_) => "ChatRegistryDurabilityUnknownError",
            Self::Codec(RegistryCodecError::ChatId(_)) => "InvalidChatIdError",
            Self::Write(error)
                if matches!(
                    error.cause.downcast_ref::<WriteFileError>(),
                    Some(WriteFileError::Atomic(_))
                ) =>
            {
                "AtomicJsonWriteError"
            }
            Self::Domain(error) => {
                return ErrorMetadata {
                    name: error.kind.name(),
                    code: Some(error.code.as_str()),
                };
            }
            _ => "Error",
        };
        ErrorMetadata { name, code: None }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum NativeSessionLookupResult {
    Found { chat_id: ChatId },
    NotFound,
    Ambiguous,
}

pub struct ChatRegistry {
    path: PathBuf,
    state: RefCell<State>,
    loaded_from_disk: bool,
    options: ChatRegistryOptions,
    write_lock: Mutex<()>,
    listeners: RefCell<Vec<RegistryListener>>,
}

struct State {
    snapshot: ChatRegistrySnapshot,
    revision: u64,
    chat_revisions: HashMap<ChatId, u64>,
    dirty: bool,
    unknown: HashSet<ChatId>,
    durable_providers: HashSet<String>,
    uncertain_providers: HashSet<String>,
    removed_executors: HashMap<String, (u64, ReferenceLease)>,
    timer: Option<CancellationToken>,
}

#[derive(Hash)]
struct IdLookup<'a>(&'a str);

impl indexmap::Equivalent<ChatId> for IdLookup<'_> {
    fn equivalent(&self, key: &ChatId) -> bool {
        self.0 == key.as_str()
    }
}

impl ChatRegistry {
    pub async fn open(workspace: &Path) -> Result<Rc<Self>, RegistryError> {
        Self::open_with_options(workspace, ChatRegistryOptions::default()).await
    }

    pub async fn open_with_options(
        workspace: &Path,
        options: ChatRegistryOptions,
    ) -> Result<Rc<Self>, RegistryError> {
        let path = workspace.join("chats.json");
        let (snapshot, loaded_from_disk) = match tokio::fs::read(&path).await {
            Ok(bytes) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Err(error) =
                        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                            .await
                    {
                        create_logger("chats:registry").warn(&format!(
                            "sessions: failed to repair chats.json permissions: {error}"
                        ));
                    }
                }
                let value = parse_stored_json(&String::from_utf8_lossy(&bytes), "chats.json")?;
                (parse_registry(&value)?, true)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                (ChatRegistrySnapshot::empty(), false)
            }
            Err(error) => return Err(error.into()),
        };
        let durable_providers = provider_ids(&snapshot);
        Ok(Rc::new(Self {
            path,
            loaded_from_disk,
            options,
            write_lock: Mutex::new(()),
            listeners: RefCell::new(Vec::new()),
            state: RefCell::new(State {
                snapshot,
                revision: 0,
                chat_revisions: HashMap::new(),
                dirty: false,
                unknown: HashSet::new(),
                durable_providers,
                uncertain_providers: HashSet::new(),
                removed_executors: HashMap::new(),
                timer: None,
            }),
        }))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn loaded_from_disk(&self) -> bool {
        self.loaded_from_disk
    }

    pub fn list_all_chats(&self) -> IndexMap<ChatId, ChatRegistryEntry> {
        self.state
            .borrow()
            .snapshot
            .sessions
            .iter()
            .map(|(id, stored)| (id.clone(), stored.entry.clone()))
            .collect()
    }

    pub fn list_chat_ids(&self) -> Vec<ChatId> {
        self.state
            .borrow()
            .snapshot
            .sessions
            .keys()
            .cloned()
            .collect()
    }

    pub fn has_chat(&self, chat_id: &str) -> bool {
        self.state
            .borrow()
            .snapshot
            .sessions
            .contains_key(&IdLookup(chat_id))
    }

    pub fn get_chat(&self, chat_id: &str) -> Option<ChatRegistryEntry> {
        self.state
            .borrow()
            .snapshot
            .sessions
            .get(&IdLookup(chat_id))
            .map(|stored| stored.entry.clone())
    }

    pub fn lookup_native_session(
        &self,
        session_id: &str,
        agent_id: Option<&str>,
        executor_id: Option<&str>,
    ) -> NativeSessionLookupResult {
        let state = self.state.borrow();
        let mut entries = state.snapshot.sessions.iter().filter(|(_, stored)| {
            let entry = &stored.entry;
            entry.executor_id.as_deref().unwrap_or(LOCAL_EXECUTOR_ID)
                == executor_id.unwrap_or(LOCAL_EXECUTOR_ID)
                && entry.agent_session_id.as_deref() == Some(session_id)
                && agent_id.is_none_or(|agent| entry.agent_id == agent)
        });
        let Some((chat_id, _)) = entries.next() else {
            return NativeSessionLookupResult::NotFound;
        };
        if entries.next().is_some() {
            return NativeSessionLookupResult::Ambiguous;
        }
        NativeSessionLookupResult::Found {
            chat_id: chat_id.clone(),
        }
    }

    pub fn get_chat_by_agent_session_id(
        &self,
        session_id: Option<&str>,
        agent_id: Option<&str>,
        executor_id: Option<&str>,
    ) -> Option<(ChatId, ChatRegistryEntry)> {
        let session_id = session_id.filter(|id| !id.is_empty())?;
        let NativeSessionLookupResult::Found { chat_id } =
            self.lookup_native_session(session_id, agent_id, executor_id)
        else {
            return None;
        };
        let entry = self.get_chat(&chat_id)?;
        Some((chat_id, entry))
    }

    pub fn references_api_provider(&self, id: &str) -> bool {
        let state = self.state.borrow();
        state.durable_providers.contains(id)
            || state.uncertain_providers.contains(id)
            || state
                .snapshot
                .sessions
                .values()
                .any(|stored| stored.entry.api_provider_id.as_deref() == Some(id))
    }

    pub fn subscribe(&self, listener: RegistryListener) {
        self.listeners.borrow_mut().push(listener);
    }

    fn emit(&self, event: RegistryEvent) -> Result<(), RegistryError> {
        let listeners = self.listeners.borrow().clone();
        for listener in listeners {
            listener(&event).map_err(RegistryError::Listener)?;
        }
        Ok(())
    }

    fn publish_project_path(&self, path: ChatProjectPathUpdatedPayload) {
        if let Err(error) = self.emit(RegistryEvent::ChatProjectPathUpdated(path)) {
            create_logger("chats:registry").warn(&format!(
                "Project-path update publication failed after persistence: {error}"
            ));
        }
    }
}

fn provider_ids(snapshot: &ChatRegistrySnapshot) -> HashSet<String> {
    snapshot
        .sessions
        .values()
        .filter_map(|stored| stored.entry.api_provider_id.as_ref())
        .filter(|id| !id.is_empty())
        .cloned()
        .collect()
}
