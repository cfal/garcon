//! Ports `server/controller/preambles/store.ts`.

use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    error::Error,
    rc::Rc,
};

use garcon_base::{
    errors::{DiagnosticError, ErrorInput, ErrorMetadata, js_string},
    json_file_store::{JsonFileStore, WriteFileError},
    keyed_lock::KeyedLock,
    portable_path::is_canonical_executor_path,
    stored_json::parse_stored_json,
};
use garcon_contract::preambles::{
    PREAMBLE_ID_LIFETIME_MAX_COUNT, PREAMBLE_MAX_COUNT, PREAMBLES_FILE_MAX_BYTES, Preamble,
    PreambleDefinition, PreambleErrorCode, PreambleScope, PreamblesSnapshot, is_preamble_id,
    normalize_preamble,
};
use garcon_js::{
    clock::{InvalidTimeValue, to_iso_string},
    date_parse::date_parse,
    is_safe_integer, json,
    path::native,
};
use serde::Serialize;
use serde_json::Value;
use tokio::fs;
use tokio_util::task::TaskTracker;

use crate::api_providers::assignments::RetainExecutorReferences;

use super::{
    Result,
    bundled::BundledPreambleDefinition,
    catalog_budget::composition_violation,
    errors::{PreambleDomainError, assert_catalog_composition},
};

const FILE_VERSION: u8 = 2;
const LOCK: &str = "preambles";
const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreamblesFile {
    version: u8,
    revision: u64,
    preambles: Vec<Preamble>,
    retired_preamble_ids: Vec<String>,
}

impl Default for PreamblesFile {
    fn default() -> Self {
        Self {
            version: FILE_VERSION,
            revision: 0,
            preambles: Vec::new(),
            retired_preamble_ids: Vec::new(),
        }
    }
}

impl PreamblesFile {
    fn byte_payload(&self) -> Result<Vec<u8>> {
        let mut bytes = serde_json::to_vec_pretty(self)?;
        bytes.push(b'\n');
        Ok(bytes)
    }

    fn lifetime_id_count(&self) -> usize {
        self.preambles.len() + self.retired_preamble_ids.len()
    }

    fn executor_ids(&self) -> Vec<Option<&str>> {
        self.preambles
            .iter()
            .flat_map(|preamble| match &preamble.definition.scope {
                PreambleScope::Global => [].as_slice(),
                PreambleScope::ProjectPaths { rules } => rules.as_slice(),
            })
            .map(|rule| rule.executor_id.as_deref())
            .collect()
    }

    fn assert_create_bounds(&self) -> Result<()> {
        if self.preambles.len() >= PREAMBLE_MAX_COUNT {
            return Err(PreambleDomainError::new(
                PreambleErrorCode::LIMIT_REACHED,
                format!("A maximum of {PREAMBLE_MAX_COUNT} preambles is allowed"),
                409,
            )
            .into());
        }
        if self.lifetime_id_count() >= PREAMBLE_ID_LIFETIME_MAX_COUNT {
            return Err(lifetime_limit().into());
        }
        Ok(())
    }

    fn assert_available_id(&self, id: &str) -> Result<()> {
        if self.preambles.iter().any(|preamble| preamble.id == id)
            || self
                .retired_preamble_ids
                .iter()
                .any(|retired| retired == id)
        {
            return Err(PreambleDomainError::new(
                PreambleErrorCode::ID_COLLISION,
                "Generated preamble ID collides with an active or retired ID",
                409,
            )
            .into());
        }
        Ok(())
    }
}

fn parse_file(value: &Value, source: &str) -> Result<(PreamblesFile, bool)> {
    let raw = value
        .as_object()
        .ok_or("preambles.json must contain an object")?;
    let version = raw.get("version");
    let migrated = version.and_then(json::as_number) == Some(1.0);
    if !migrated && version.and_then(json::as_number) != Some(f64::from(FILE_VERSION)) {
        let version = js_string(version.map_or(ErrorInput::Undefined, ErrorInput::Json));
        return Err(format!("Unsupported preambles.json version: {version}").into());
    }
    if raw.keys().any(|key| match key.as_str() {
        "version" | "revision" | "preambles" => false,
        "retiredPreambleIds" => migrated,
        _ => true,
    }) {
        return Err("preambles.json is invalid".into());
    }
    let revision = raw
        .get("revision")
        .and_then(json::as_number)
        .filter(|number| *number >= 0.0 && is_safe_integer(*number))
        .ok_or("preambles.json is invalid")? as u64;
    let preambles = parse_active(&value["preambles"], source)?;
    let retired_preamble_ids = if migrated {
        Vec::new()
    } else {
        parse_retired(&value["retiredPreambleIds"], &preambles)?
    };
    let file = PreamblesFile {
        version: FILE_VERSION,
        revision,
        preambles,
        retired_preamble_ids,
    };
    if file.lifetime_id_count() > PREAMBLE_ID_LIFETIME_MAX_COUNT {
        return Err("preambles.json exceeds the preamble ID lifetime limit".into());
    }
    Ok((file, migrated))
}

fn parse_active(raw: &Value, source: &str) -> Result<Vec<Preamble>> {
    const INVALID_PATH: &str = "preambles.json contains a non-canonical project path";
    let items = raw
        .as_array()
        .filter(|items| items.len() <= PREAMBLE_MAX_COUNT)
        .ok_or("preambles.json is invalid")?;
    let mut ids = HashSet::new();
    let mut preambles = Vec::with_capacity(items.len());
    let mut marked = None;
    for (preamble_index, item) in items.iter().enumerate() {
        let preamble = normalize_preamble(item)
            .filter(|preamble| !ids.contains(&preamble.id))
            .ok_or("preambles.json contains an invalid preamble")?;
        if let PreambleScope::ProjectPaths { rules } = &preamble.definition.scope {
            for (index, rule) in rules.iter().enumerate() {
                if item["scope"]["rules"][index]["projectPath"].as_str()
                    != Some(rule.project_path.as_str())
                    || !is_canonical_executor_path(&rule.project_path)
                {
                    return Err(INVALID_PATH.into());
                }
                if rule.project_path.contains('\u{fffd}') {
                    // A projected surrogate must not turn a refused v1 file into a v2 write.
                    // The alternate parse is used only for paths; other content is unchanged.
                    if marked.is_none() {
                        marked = Some(json::parse_replacing_unpaired_surrogate_values(
                            source, false,
                        )?);
                    }
                    if let Some(probe) = &marked
                        && probe["preambles"][preamble_index]["scope"]["rules"][index]["projectPath"]
                            == Value::Bool(false)
                    {
                        return Err(INVALID_PATH.into());
                    }
                }
            }
        }
        ids.insert(preamble.id.clone());
        preambles.push(preamble);
    }
    if duplicate_short_name(&preambles).is_some() {
        return Err("preambles.json contains duplicate snippet short names".into());
    }
    Ok(preambles)
}

fn duplicate_short_name(preambles: &[Preamble]) -> Option<&str> {
    let mut names = HashSet::new();
    preambles
        .iter()
        .filter_map(|preamble| preamble.definition.snippet_short_name.as_deref())
        .find(|name| !names.insert(*name))
}

fn parse_retired(raw: &Value, preambles: &[Preamble]) -> Result<Vec<String>> {
    let items = raw.as_array().ok_or("preambles.json is invalid")?;
    let mut retired = HashSet::new();
    let mut ids = Vec::with_capacity(items.len());
    for item in items {
        let id = item
            .as_str()
            .filter(|id| is_preamble_id(item) && retired.insert(*id))
            .ok_or("preambles.json contains an invalid retired preamble ID")?;
        ids.push(id.to_owned());
    }
    if preambles
        .iter()
        .any(|preamble| retired.contains(preamble.id.as_str()))
    {
        return Err("preambles.json contains an ID that is both active and retired".into());
    }
    Ok(ids)
}

#[derive(Debug, thiserror::Error)]
#[error("The preambles catalog was committed, but its durability could not be confirmed.")]
pub struct PreambleCatalogCommittedUnknownError(#[source] Box<dyn Error>);

impl DiagnosticError for PreambleCatalogCommittedUnknownError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "PreambleCatalogCommittedUnknownError",
            code: None,
        }
    }
}

#[async_trait::async_trait(?Send)]
pub(super) trait CatalogWriter {
    async fn write(&self, path: &str, payload: &[u8]) -> Result<()>;
}

#[async_trait::async_trait(?Send)]
impl CatalogWriter for JsonFileStore {
    async fn write(&self, path: &str, payload: &[u8]) -> Result<()> {
        match self.write_file_atomic(path, payload, Some(0o600)).await {
            Ok(()) => Ok(()),
            Err(WriteFileError::Atomic(error)) if error.renamed => {
                Err(PreambleCatalogCommittedUnknownError(error.into()).into())
            }
            Err(error) => Err(error.into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BundledPreambleInstallResult {
    pub installed: usize,
    pub deferred: usize,
}

pub struct PreambleStore {
    path: String,
    lock: KeyedLock,
    file: RefCell<PreamblesFile>,
    unknown_durability: Cell<bool>,
    tasks: TaskTracker,
    writer: Rc<dyn CatalogWriter>,
}

impl PreambleStore {
    pub async fn open(workspace_dir: &str) -> Result<Rc<Self>> {
        Self::open_with_writer(workspace_dir, Rc::new(JsonFileStore::default())).await
    }

    pub(super) async fn open_with_writer(
        workspace_dir: &str,
        writer: Rc<dyn CatalogWriter>,
    ) -> Result<Rc<Self>> {
        let path = native::join(&[workspace_dir, "preambles.json"]);
        let file = match fs::read(&path).await {
            Ok(raw) => {
                let raw = String::from_utf8_lossy(&raw);
                if raw.len() > PREAMBLES_FILE_MAX_BYTES {
                    return Err("preambles.json exceeds the maximum file size".into());
                }
                let value = parse_stored_json(&raw, "preambles.json")?;
                let (file, migrated) = parse_file(&value, &raw)?;
                if composition_violation(&file.preambles)?.is_some() {
                    return Err(
                        "preambles.json contains an invalid combined preamble composition".into(),
                    );
                }
                if migrated {
                    let payload = file.byte_payload()?;
                    if payload.len() > PREAMBLES_FILE_MAX_BYTES {
                        return Err(
                            "Migrated preambles.json would exceed the maximum file size".into()
                        );
                    }
                    writer.write(&path, &payload).await?;
                }
                file
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => PreamblesFile::default(),
            Err(error) => return Err(error.into()),
        };
        Ok(Rc::new(Self {
            path,
            lock: KeyedLock::new(),
            file: RefCell::new(file),
            unknown_durability: Cell::new(false),
            tasks: TaskTracker::new(),
            writer,
        }))
    }

    pub async fn drain(&self) {
        self.tasks.close();
        self.tasks.wait().await;
    }

    pub fn snapshot(&self) -> PreamblesSnapshot {
        let file = self.file.borrow();
        PreamblesSnapshot {
            revision: file.revision,
            preambles: file.preambles.clone(),
        }
    }

    pub fn get_by_snippet_short_name(&self, name: &str) -> Option<Preamble> {
        self.file
            .borrow()
            .preambles
            .iter()
            .find(|preamble| preamble.definition.snippet_short_name.as_deref() == Some(name))
            .cloned()
    }

    pub fn lifetime_id_count(&self) -> usize {
        self.file.borrow().lifetime_id_count()
    }

    pub(super) async fn install_bundled(
        self: &Rc<Self>,
        definitions: &[BundledPreambleDefinition],
        installed_at_ms: i64,
        retain: Option<RetainExecutorReferences>,
    ) -> Result<BundledPreambleInstallResult> {
        let timestamp = to_iso_string(installed_at_ms)?;
        let mut normalized = Vec::new();
        let mut ids = HashSet::new();
        for definition in definitions {
            if !ids.insert(definition.id.as_str()) {
                return Err("Bundled preambles contain duplicate IDs".into());
            }
            if definition.definition.enabled {
                return Err(PreambleDomainError::new(
                    PreambleErrorCode::VALIDATION_FAILED,
                    "Bundled preambles must be disabled by default",
                    500,
                )
                .into());
            }
            normalized.push(normalize_created(Preamble {
                id: definition.id.clone(),
                definition: definition.definition.clone(),
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
            })?);
        }

        let (revision, missing, install) = {
            let file = self.file.borrow();
            let known: HashSet<_> = file
                .preambles
                .iter()
                .map(|preamble| preamble.id.as_str())
                .chain(file.retired_preamble_ids.iter().map(String::as_str))
                .collect();
            normalized.retain(|preamble| !known.contains(preamble.id.as_str()));
            let slots = (PREAMBLE_MAX_COUNT - file.preambles.len())
                .min(PREAMBLE_ID_LIFETIME_MAX_COUNT - file.lifetime_id_count());
            (file.revision, normalized.len(), normalized.len().min(slots))
        };
        normalized.truncate(install);
        if install > 0 {
            self.mutate(revision, retain, move |file| {
                file.preambles.extend(normalized);
                Ok(())
            })
            .await?;
        }
        Ok(BundledPreambleInstallResult {
            installed: install,
            deferred: missing - install,
        })
    }

    pub async fn create_with_generated_id(
        self: &Rc<Self>,
        expected_revision: u64,
        generate: impl FnOnce() -> String + 'static,
        build: impl FnOnce(&str) -> Preamble + 'static,
        validate_short_name: impl FnOnce() -> Result<()> + 'static,
        retain: RetainExecutorReferences,
    ) -> Result<()> {
        self.mutate(expected_revision, Some(retain), move |file| {
            file.assert_create_bounds()?;
            let id = generate();
            if !is_preamble_id(&Value::String(id.clone())) {
                return Err(PreambleDomainError::new(
                    PreambleErrorCode::VALIDATION_FAILED,
                    "Generated preamble ID is not a canonical UUID v4",
                    500,
                )
                .into());
            }
            file.assert_available_id(&id)?;
            let preamble = normalize_created(build(&id))?;
            if preamble.id != id {
                return Err(PreambleDomainError::new(
                    PreambleErrorCode::VALIDATION_FAILED,
                    "Generated preamble does not use its assigned ID",
                    500,
                )
                .into());
            }
            validate_short_name()?;
            file.preambles.push(preamble);
            Ok(())
        })
        .await
    }

    pub async fn create(
        self: &Rc<Self>,
        preamble: Preamble,
        expected_revision: u64,
        retain: RetainExecutorReferences,
    ) -> Result<()> {
        self.mutate(expected_revision, Some(retain), move |file| {
            file.assert_create_bounds()?;
            let preamble = normalize_created(preamble)?;
            file.assert_available_id(&preamble.id)?;
            file.preambles.push(preamble);
            Ok(())
        })
        .await
    }

    pub async fn update(
        self: &Rc<Self>,
        id: String,
        definition: PreambleDefinition,
        updated_at: String,
        expected_revision: u64,
        validate_short_name: impl FnOnce() -> Result<()> + 'static,
        retain: RetainExecutorReferences,
    ) -> Result<()> {
        self.mutate(expected_revision, Some(retain), move |file| {
            let current = file
                .preambles
                .iter_mut()
                .find(|entry| entry.id == id)
                .ok_or_else(not_found)?;
            validate_short_name()?;
            let previous = date_parse(&current.updated_at).ok_or(InvalidTimeValue)?;
            let updated_at = date_parse(&updated_at).ok_or(InvalidTimeValue)?;
            current.updated_at = to_iso_string(updated_at.max(previous + 1))?;
            current.definition = definition;
            Ok(())
        })
        .await
    }

    pub async fn remove(
        self: &Rc<Self>,
        id: String,
        expected_revision: u64,
        retain: RetainExecutorReferences,
    ) -> Result<()> {
        self.mutate(expected_revision, Some(retain), move |file| {
            let index = file
                .preambles
                .iter()
                .position(|entry| entry.id == id)
                .ok_or_else(not_found)?;
            file.retired_preamble_ids
                .push(file.preambles.remove(index).id);
            Ok(())
        })
        .await
    }

    pub async fn reorder(
        self: &Rc<Self>,
        ids: Vec<String>,
        expected_revision: u64,
        retain: RetainExecutorReferences,
    ) -> Result<()> {
        self.mutate(expected_revision, Some(retain), move |file| {
            file.preambles = reordered_preambles(&file.preambles, &ids).ok_or_else(|| {
                PreambleDomainError::new(
                    PreambleErrorCode::VALIDATION_FAILED,
                    "Preamble order is invalid",
                    400,
                )
            })?;
            Ok(())
        })
        .await
    }

    async fn mutate(
        self: &Rc<Self>,
        expected_revision: u64,
        retain: Option<RetainExecutorReferences>,
        change: impl FnOnce(&mut PreamblesFile) -> Result<()> + 'static,
    ) -> Result<()> {
        let store = self.clone();
        self.tasks.spawn_local(async move {
            store.lock.run_exclusive(LOCK, || async {
                if store.unknown_durability.get() {
                    return Err(PreambleDomainError::new(PreambleErrorCode::CATALOG_SAVE_UNKNOWN,
                        "The preambles catalog has an unconfirmed save; restart the server before further catalog changes.", 503).into());
                }
                let before = store.file.borrow().clone();
                if before.revision != expected_revision {
                    let mut error = PreambleDomainError::new(PreambleErrorCode::REVISION_CONFLICT,
                        "Preambles changed in another client; refresh and try again", 409);
                    error.retryable = true;
                    return Err(error.into());
                }
                if before.revision == MAX_REVISION {
                    return Err(PreambleDomainError::new(PreambleErrorCode::REVISION_EXHAUSTED,
                        "Preamble revision limit reached", 409).into());
                }
                let mut draft = before.clone();
                change(&mut draft)?;
                if let Some(name) = duplicate_short_name(&draft.preambles) {
                    return Err(PreambleDomainError::new(PreambleErrorCode::SNIPPET_NAME_CONFLICT,
                        format!("A snippet named {name} already exists"), 409).into());
                }
                if draft.lifetime_id_count() > PREAMBLE_ID_LIFETIME_MAX_COUNT {
                    return Err(lifetime_limit().into());
                }
                assert_catalog_composition(&draft.preambles)?;
                draft.revision += 1;
                let payload = draft.byte_payload()?;
                if payload.len() > PREAMBLES_FILE_MAX_BYTES {
                    return Err(PreambleDomainError::new(PreambleErrorCode::VALIDATION_FAILED,
                        "The preambles catalog would exceed the maximum file size", 400).into());
                }
                let release = retain.map(|retain| retain(&draft.executor_ids(), &before.executor_ids())).transpose()?;
                let result = store.writer.write(&store.path, &payload).await;
                let committed_unknown = result.as_ref().is_err_and(|error| error.is::<PreambleCatalogCommittedUnknownError>());
                if result.is_ok() || committed_unknown {
                    *store.file.borrow_mut() = draft;
                    store.unknown_durability.set(committed_unknown);
                }
                if let Some(release) = release {
                    release();
                }
                result
            }, None).await?
        }).await?
    }
}

fn normalize_created(value: Preamble) -> Result<Preamble> {
    normalize_preamble(&serde_json::to_value(value)?).ok_or_else(|| {
        PreambleDomainError::new(
            PreambleErrorCode::VALIDATION_FAILED,
            "Preamble is invalid",
            500,
        )
        .into()
    })
}

pub fn reordered_preambles(
    preambles: &[Preamble],
    ordered_ids: &[String],
) -> Option<Vec<Preamble>> {
    if ordered_ids.len() != preambles.len()
        || ordered_ids.iter().collect::<HashSet<_>>().len() != ordered_ids.len()
    {
        return None;
    }
    let by_id: HashMap<_, _> = preambles
        .iter()
        .map(|preamble| (&preamble.id, preamble))
        .collect();
    ordered_ids
        .iter()
        .map(|id| by_id.get(id).map(|preamble| (*preamble).clone()))
        .collect()
}

fn not_found() -> PreambleDomainError {
    PreambleDomainError::new(PreambleErrorCode::NOT_FOUND, "Preamble not found", 404)
}

fn lifetime_limit() -> PreambleDomainError {
    PreambleDomainError::new(
        PreambleErrorCode::ID_LIFETIME_LIMIT_REACHED,
        format!(
            "The workspace preamble ID lifetime limit of {PREAMBLE_ID_LIFETIME_MAX_COUNT} is reached"
        ),
        409,
    )
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
