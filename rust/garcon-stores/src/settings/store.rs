//! Owns the cache and write lock for `project-settings.json`.

use std::cell::RefCell;
use std::collections::HashSet;
use std::error::Error;
use std::rc::Rc;

use garcon_base::errors::NamedError;
use garcon_base::json_file_store::{JsonFileStore, JsonWriteOptions, WriteFileError};
use garcon_base::keyed_lock::KeyedLock;
use garcon_contract::settings::{
    AGENT_COMMAND_SETTING_KEYS, DEFAULT_REMOTE_FEATURE_SETTINGS, GENERATION_UI_SETTING_KEYS,
    default_execution_defaults, normalize_remote_feature_settings,
};
use garcon_js::json::Opaque;
use garcon_js::{json, path::native};
use serde_json::{Map, Value};

use super::settings_shared::{
    normalize_remote_settings_version, normalize_ui_settings, optional_string,
    sanitize_folder_filter, sanitize_string_array,
};
use super::startup_recents::{
    dedupe_recent_agent_settings, full_execution_defaults_patch, legacy_execution_defaults,
    legacy_recent_agent_setting, order_execution_defaults_keys,
    sanitize_execution_defaults_settings, sanitize_path_settings, sanitize_recent_agent_settings,
};
use super::types::{ChatFolder, ProjectSettings, SavedChatSearch};

type BoxError = Box<dyn Error>;
type ReleaseReferences = Box<dyn FnOnce()>;
pub type RetainSettingsReferences =
    Rc<dyn Fn(&[String], &[String]) -> Result<ReleaseReferences, BoxError>>;
type ChangeListener = Rc<dyn Fn(&SettingsChange) -> Result<(), BoxError>>;

const WRITE_LOCK: &str = "project-settings";
const LEGACY_KEYS: [&str; 8] = [
    "lastAgentId",
    "lastProjectPath",
    "lastModel",
    "lastApiProviderId",
    "lastModelEndpointId",
    "lastModelProtocol",
    "lastPermissionMode",
    "lastThinkingMode",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsChange {
    RemoteSettings,
    SessionName { chat_id: String, title: String },
    List { reason: String, chat_id: String },
}

pub(super) enum Mutation<T> {
    Unchanged(T),
    Save(T, Vec<SettingsChange>),
}

#[derive(Default)]
pub struct SettingsStoreOptions {
    pub retain_executor_references: Option<RetainSettingsReferences>,
    pub retain_provider_references: Option<RetainSettingsReferences>,
}

struct WriteFailure {
    renamed: bool,
    source: BoxError,
}

#[async_trait::async_trait(?Send)]
trait SettingsWriter {
    async fn write(&self, file_path: &str, settings: &ProjectSettings) -> Result<(), WriteFailure>;
}

#[async_trait::async_trait(?Send)]
impl SettingsWriter for JsonFileStore {
    async fn write(&self, file_path: &str, settings: &ProjectSettings) -> Result<(), WriteFailure> {
        self.write_json_file_atomic(
            file_path,
            settings,
            JsonWriteOptions {
                mode: Some(0o600),
                ..Default::default()
            },
        )
        .await
        .map_err(|error| WriteFailure {
            renamed: matches!(&error, WriteFileError::Atomic(error) if error.renamed),
            source: error.into(),
        })?;
        Ok(())
    }
}

pub struct SettingsStore {
    file_path: String,
    current: RefCell<Rc<ProjectSettings>>,
    write_lock: KeyedLock,
    writer: Rc<dyn SettingsWriter>,
    options: SettingsStoreOptions,
    pending: RefCell<Option<PendingDurability>>,
    listeners: RefCell<Vec<ChangeListener>>,
}

struct PendingDurability {
    notifications: Vec<SettingsChange>,
    providers: HashSet<String>,
}

struct References(Option<ReleaseReferences>);

impl Drop for References {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            release();
        }
    }
}

fn retain(
    port: Option<&RetainSettingsReferences>,
    next: &[String],
    previous: &[String],
) -> Result<References, BoxError> {
    Ok(References(
        port.map(|callback| callback(next, previous)).transpose()?,
    ))
}

impl SettingsStore {
    pub async fn open(
        workspace_dir: &str,
        options: SettingsStoreOptions,
    ) -> Result<Rc<Self>, BoxError> {
        Self::open_with_writer(workspace_dir, options, Rc::new(JsonFileStore::default())).await
    }

    async fn open_with_writer(
        workspace_dir: &str,
        options: SettingsStoreOptions,
        writer: Rc<dyn SettingsWriter>,
    ) -> Result<Rc<Self>, BoxError> {
        tokio::fs::create_dir_all(workspace_dir).await?;
        let file_path = native::join(&[workspace_dir, "project-settings.json"]);
        let (settings, migrated) = read(&file_path).await?;
        let store = Rc::new(Self {
            file_path,
            current: RefCell::new(Rc::new(settings)),
            write_lock: KeyedLock::new(),
            writer,
            options,
            pending: RefCell::new(None),
            listeners: RefCell::new(Vec::new()),
        });
        if migrated {
            store.write_candidate(store.snapshot(), Vec::new()).await?;
        }
        Ok(store)
    }

    pub fn snapshot(&self) -> Rc<ProjectSettings> {
        Rc::clone(&self.current.borrow())
    }

    pub fn on_change(self: &Rc<Self>, listener: ChangeListener) -> impl FnOnce() + use<> {
        self.listeners.borrow_mut().push(Rc::clone(&listener));
        let store = Rc::downgrade(self);
        move || {
            if let Some(store) = store.upgrade() {
                store
                    .listeners
                    .borrow_mut()
                    .retain(|candidate| !Rc::ptr_eq(candidate, &listener));
            }
        }
    }

    pub fn references_api_provider(&self, id: &str) -> bool {
        self.pending
            .borrow()
            .as_ref()
            .is_some_and(|pending| pending.providers.contains(id))
            || generation_references(&self.snapshot(), "apiProviderId")
                .iter()
                .any(|provider| provider == id)
    }

    pub async fn reload(&self) -> Result<Rc<ProjectSettings>, BoxError> {
        self.write_lock
            .run_exclusive(
                WRITE_LOCK,
                || async {
                    let (settings, migrated) = read(&self.file_path).await?;
                    let settings = Rc::new(settings);
                    self.current.replace(Rc::clone(&settings));
                    self.pending.replace(None);
                    if migrated {
                        self.write_candidate(Rc::clone(&settings), Vec::new())
                            .await?;
                    }
                    Ok(settings)
                },
                None,
            )
            .await?
    }

    pub async fn confirm_durability(&self) -> Result<(), BoxError> {
        self.write_lock
            .run_exclusive(WRITE_LOCK, || self.confirm_pending(), None)
            .await?
    }

    pub async fn confirm_archive_state(&self, chat_id: &str) -> Result<bool, BoxError> {
        self.write_lock
            .run_exclusive(
                WRITE_LOCK,
                || async {
                    self.confirm_pending().await?;
                    Ok(self
                        .snapshot()
                        .archived_chat_ids
                        .iter()
                        .any(|id| id == chat_id))
                },
                None,
            )
            .await?
    }

    pub async fn save_settings(&self, raw: &Value) -> Result<(), BoxError> {
        self.write_lock
            .run_exclusive(
                WRITE_LOCK,
                || async {
                    self.confirm_pending().await?;
                    self.write_candidate(Rc::new(sanitize_project_settings(raw).0), Vec::new())
                        .await
                },
                None,
            )
            .await?
    }

    pub(super) async fn mutate<T>(
        &self,
        change: impl FnOnce(&mut ProjectSettings) -> Result<Mutation<T>, BoxError>,
    ) -> Result<T, BoxError> {
        self.write_lock
            .run_exclusive(
                WRITE_LOCK,
                || async {
                    self.confirm_pending().await?;
                    let mut next = (*self.snapshot()).clone();
                    let (result, notifications) = match change(&mut next)? {
                        Mutation::Unchanged(result) => return Ok(result),
                        Mutation::Save(result, notifications) => (result, notifications),
                    };
                    let raw = json::from_slice(&serde_json::to_vec(&next)?)?;
                    self.write_candidate(Rc::new(sanitize_project_settings(&raw).0), notifications)
                        .await?;
                    Ok(result)
                },
                None,
            )
            .await?
    }

    async fn confirm_pending(&self) -> Result<(), BoxError> {
        if self.pending.borrow().is_none() {
            return Ok(());
        }
        let current = self.snapshot();
        let providers = self.retain_providers(&current, &current)?;
        self.writer
            .write(&self.file_path, &current)
            .await
            .map_err(|error| error.source)?;
        drop(providers);
        self.publish(Vec::new())
    }

    async fn write_candidate(
        &self,
        candidate: Rc<ProjectSettings>,
        notifications: Vec<SettingsChange>,
    ) -> Result<(), BoxError> {
        let previous = self.snapshot();
        let _executors = retain(
            self.options.retain_executor_references.as_ref(),
            &generation_references(&candidate, "executorId"),
            &generation_references(&previous, "executorId"),
        )?;
        let providers = self.retain_providers(&candidate, &previous)?;
        if let Err(error) = self.writer.write(&self.file_path, &candidate).await {
            if error.renamed {
                let mut pending = self.pending.borrow_mut();
                let pending = pending.get_or_insert_with(|| PendingDurability {
                    notifications: Vec::new(),
                    providers: generation_references(&previous, "apiProviderId")
                        .into_iter()
                        .collect(),
                });
                pending
                    .providers
                    .extend(generation_references(&candidate, "apiProviderId"));
                pending.notifications.extend(notifications);
                self.current.replace(candidate);
            }
            return Err(error.source);
        }
        self.current.replace(candidate);
        drop(providers);
        self.publish(notifications)
    }

    fn retain_providers(
        &self,
        candidate: &ProjectSettings,
        previous: &ProjectSettings,
    ) -> Result<References, BoxError> {
        let mut existing = generation_references(previous, "apiProviderId");
        if let Some(pending) = self.pending.borrow().as_ref() {
            existing.extend(pending.providers.iter().cloned());
        }
        retain(
            self.options.retain_provider_references.as_ref(),
            &generation_references(candidate, "apiProviderId"),
            &existing,
        )
    }

    fn publish(&self, notifications: Vec<SettingsChange>) -> Result<(), BoxError> {
        let mut confirmed = self
            .pending
            .take()
            .map_or_else(Vec::new, |pending| pending.notifications);
        confirmed.extend(notifications);
        for notification in &confirmed {
            let listeners = self.listeners.borrow().clone();
            for listener in listeners {
                listener(notification)?;
            }
        }
        Ok(())
    }
}

fn generation_references(settings: &ProjectSettings, field: &str) -> Vec<String> {
    GENERATION_UI_SETTING_KEYS
        .iter()
        .filter_map(|key| settings.ui[*key][field].as_str().map(str::to_owned))
        .collect()
}

async fn read(file_path: &str) -> Result<(ProjectSettings, bool), BoxError> {
    Ok(JsonFileStore::default()
        .read_json_state_file(
            file_path,
            || (empty_settings(), false),
            |value| {
                if !value.is_object() {
                    return Err(Box::new(NamedError {
                        name: "TypeError".into(),
                        message: "Project settings state must be a JSON object".into(),
                        code: None,
                    }));
                }
                Ok(sanitize_project_settings(&value))
            },
        )
        .await?)
}

fn empty_settings() -> ProjectSettings {
    let empty_object = || Opaque::from(Value::Object(Map::new()));
    ProjectSettings {
        features: DEFAULT_REMOTE_FEATURE_SETTINGS,
        ui: empty_object(),
        paths: empty_object(),
        chat_names: empty_object(),
        remote_settings_version: 0,
        pinned_chat_ids: Vec::new(),
        normal_chat_ids: Vec::new(),
        archived_chat_ids: Vec::new(),
        recent_agent_settings: Vec::new(),
        execution_defaults: garcon_contract::settings::RemoteExecutionDefaults {
            global: default_execution_defaults(),
            by_agent: Default::default(),
        },
        chat_folders: Vec::new(),
        saved_chat_searches: Vec::new(),
    }
}

fn sanitize_folder(raw: &Value) -> Option<ChatFolder> {
    Some(ChatFolder {
        id: optional_string(&raw["id"])?.into(),
        name: optional_string(&raw["name"])?.into(),
        filter: sanitize_folder_filter(&raw["filter"]),
        created_at: optional_string(&raw["createdAt"])?.into(),
    })
}

fn sanitize_saved_search(raw: &Value) -> Option<SavedChatSearch> {
    let flag = |name| raw[name].as_bool().unwrap_or_default();
    let show_as_sidebar_pill = flag("showAsSidebarPill");
    let show_in_sidebar_menu = flag("showInSidebarMenu");
    let show_in_search_dialog = flag("showInSearchDialog");
    if !(show_as_sidebar_pill || show_in_sidebar_menu || show_in_search_dialog) {
        return None;
    }
    Some(SavedChatSearch {
        id: optional_string(&raw["id"])?.into(),
        title: optional_string(&raw["title"]).map(str::to_owned),
        query: optional_string(&raw["query"])?.into(),
        show_as_sidebar_pill,
        show_in_sidebar_menu,
        show_in_search_dialog,
        created_at: optional_string(&raw["createdAt"])?.into(),
        updated_at: optional_string(&raw["updatedAt"])?.into(),
    })
}

fn sanitize_project_settings(raw: &Value) -> (ProjectSettings, bool) {
    let features = &raw["features"];
    let commands = &features["agentCommands"];
    let mut migrated = !raw.is_object()
        || !features["transcriptSearch"]["enabled"].is_boolean()
        || AGENT_COMMAND_SETTING_KEYS
            .iter()
            .any(|key| !commands[*key].is_boolean())
        || commands.as_object().is_some_and(|map| {
            map.keys()
                .any(|key| !AGENT_COMMAND_SETTING_KEYS.contains(&key.as_str()))
        })
        || features.get("chatIdDiscovery").is_some();

    let chat_folders: Vec<_> = raw["chatFolders"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(sanitize_folder)
        .collect();
    let saved_chat_searches: Vec<_> = raw["savedChatSearches"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(sanitize_saved_search)
        .collect();
    migrated |= raw["chatFolders"]
        .as_array()
        .is_some_and(|rows| rows.len() != chat_folders.len());
    migrated |= raw["savedChatSearches"]
        .as_array()
        .is_some_and(|rows| rows.len() != saved_chat_searches.len());
    migrated |= LEGACY_KEYS.iter().any(|field| raw.get(*field).is_some());

    let (paths, paths_migrated) = sanitize_path_settings(raw);
    let (mut recent, recent_migrated) = sanitize_recent_agent_settings(&raw["recentAgentSettings"]);
    recent.extend(legacy_recent_agent_setting(raw));
    let (mut execution_defaults, execution_migrated) =
        sanitize_execution_defaults_settings(&raw["executionDefaults"]);
    migrated |= paths_migrated || recent_migrated || execution_migrated;
    if raw.get("lastPermissionMode").is_some() || raw.get("lastThinkingMode").is_some() {
        let legacy = legacy_execution_defaults(raw);
        if let Some(agent_id) = optional_string(&raw["lastAgentId"]) {
            execution_defaults
                .by_agent
                .insert(agent_id.into(), full_execution_defaults_patch(&legacy));
            order_execution_defaults_keys(&mut execution_defaults);
        }
        execution_defaults.global = legacy;
    }
    let chat_names = Value::Object(
        raw["chatNames"]
            .as_object()
            .into_iter()
            .flat_map(|map| map.iter())
            .filter(|(key, name)| key.as_str() != "__proto__" && name.is_string())
            .map(|(key, name)| (key.clone(), name.clone()))
            .collect(),
    );
    (
        ProjectSettings {
            features: normalize_remote_feature_settings(features),
            ui: normalize_ui_settings(&raw["ui"]).into(),
            paths: paths.into(),
            chat_names: chat_names.into(),
            remote_settings_version: normalize_remote_settings_version(
                &raw["remoteSettingsVersion"],
            ),
            pinned_chat_ids: sanitize_string_array(&raw["pinnedChatIds"]),
            normal_chat_ids: sanitize_string_array(&raw["normalChatIds"]),
            archived_chat_ids: sanitize_string_array(&raw["archivedChatIds"]),
            recent_agent_settings: dedupe_recent_agent_settings(recent),
            execution_defaults,
            chat_folders,
            saved_chat_searches,
        },
        migrated,
    )
}

#[cfg(test)]
mod tests;
