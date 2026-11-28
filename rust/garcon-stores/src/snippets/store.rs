//! Ports `server/controller/snippets/store.ts`.

use std::{
    cell::{Cell, RefCell},
    collections::HashSet,
    error::Error,
    rc::Rc,
};

use garcon_base::{
    errors::{DiagnosticError, ErrorInput, ErrorMetadata, js_string},
    json_file_store::{JsonFileStore, JsonWriteOptions, WriteFileError},
    keyed_lock::KeyedLock,
    stored_json::parse_stored_json,
};
use garcon_contract::snippets::{
    SNIPPET_MAX_COUNT, Snippet, SnippetDefinitionInput, SnippetErrorCode, SnippetsSnapshot,
    normalize_snippet, sort_snippets_by_short_name,
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

use super::{Result, errors::SnippetDomainError};

const FILE_VERSION: u8 = 2;
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const LOCK: &str = "snippets";

#[derive(Debug, Clone, Serialize)]
struct SnippetsFile {
    version: u8,
    revision: u64,
    snippets: Vec<Snippet>,
}

impl Default for SnippetsFile {
    fn default() -> Self {
        Self {
            version: FILE_VERSION,
            revision: 0,
            snippets: Vec::new(),
        }
    }
}

fn normalize_file(value: &Value) -> Result<(SnippetsFile, bool)> {
    let Some(raw) = value.as_object() else {
        return Ok((SnippetsFile::default(), false));
    };
    let version = raw.get("version");
    let migrated = version.and_then(json::as_number) == Some(1.0);
    if !migrated && version.and_then(json::as_number) != Some(f64::from(FILE_VERSION)) {
        let version = js_string(version.map_or(ErrorInput::Undefined, ErrorInput::Json));
        return Err(format!("Unsupported snippets.json version: {version}").into());
    }
    let revision = raw
        .get("revision")
        .and_then(json::as_number)
        .filter(|n| *n >= 0.0 && is_safe_integer(*n))
        .unwrap_or(0.0) as u64;
    let mut snippets = Vec::new();
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    if let Some(entries) = raw.get("snippets").and_then(Value::as_array) {
        for entry in entries {
            let parsed = if migrated {
                entry.as_object().and_then(|entry| {
                    let mut entry = entry.clone();
                    entry.insert("defaultArguments".into(), Value::String(String::new()));
                    normalize_snippet(&Value::Object(entry))
                })
            } else {
                normalize_snippet(entry)
            };
            let Some(snippet) = parsed else { continue };
            if ids.contains(&snippet.id) || names.contains(&snippet.definition.short_name) {
                continue;
            }
            if snippets.len() == SNIPPET_MAX_COUNT {
                return Err(format!(
                    "snippets.json exceeds the maximum of {SNIPPET_MAX_COUNT} snippets"
                )
                .into());
            }
            ids.insert(snippet.id.clone());
            names.insert(snippet.definition.short_name.clone());
            snippets.push(snippet);
        }
    }
    Ok((
        SnippetsFile {
            version: FILE_VERSION,
            revision,
            snippets: sort_snippets_by_short_name(&snippets),
        },
        migrated,
    ))
}

#[derive(Debug, thiserror::Error)]
#[error("The snippets catalog was committed, but its durability could not be confirmed.")]
pub struct SnippetCatalogCommittedUnknownError(#[source] Box<dyn Error>);

impl DiagnosticError for SnippetCatalogCommittedUnknownError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "SnippetCatalogCommittedUnknownError",
            code: None,
        }
    }
}

#[async_trait::async_trait(?Send)]
trait Writer {
    async fn write(&self, path: &str, candidate: &SnippetsFile) -> Result<()>;
}

#[async_trait::async_trait(?Send)]
impl Writer for JsonFileStore {
    async fn write(&self, path: &str, candidate: &SnippetsFile) -> Result<()> {
        match self
            .write_json_file_atomic(
                path,
                candidate,
                JsonWriteOptions {
                    mode: Some(0o600),
                    ..JsonWriteOptions::default()
                },
            )
            .await
        {
            Ok(()) => Ok(()),
            Err(WriteFileError::Atomic(error)) if error.renamed => {
                Err(SnippetCatalogCommittedUnknownError(error.into()).into())
            }
            Err(error) => Err(error.into()),
        }
    }
}

pub struct SnippetStore {
    path: String,
    lock: KeyedLock,
    file: RefCell<SnippetsFile>,
    unknown_durability: Cell<bool>,
    tasks: TaskTracker,
    writer: Rc<dyn Writer>,
}

impl SnippetStore {
    pub async fn open(workspace_dir: &str) -> Result<Rc<Self>> {
        Self::open_with_writer(workspace_dir, Rc::new(JsonFileStore::default())).await
    }

    async fn open_with_writer(workspace_dir: &str, writer: Rc<dyn Writer>) -> Result<Rc<Self>> {
        let path = native::join(&[workspace_dir, "snippets.json"]);
        let file = match fs::read(&path).await {
            Ok(raw) => {
                let value = parse_stored_json(&String::from_utf8_lossy(&raw), "snippets.json")?;
                let (file, migrated) = normalize_file(&value)?;
                if migrated {
                    writer.write(&path, &file).await?;
                }
                file
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => SnippetsFile::default(),
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

    pub fn snapshot(&self) -> SnippetsSnapshot {
        let file = self.file.borrow();
        SnippetsSnapshot {
            revision: file.revision,
            snippets: file.snippets.clone(),
        }
    }

    pub fn get_by_short_name(&self, short_name: &str) -> Option<Snippet> {
        self.file
            .borrow()
            .snippets
            .iter()
            .find(|entry| entry.definition.short_name == short_name)
            .cloned()
    }

    pub async fn create(
        self: &Rc<Self>,
        snippet: Snippet,
        expected_revision: u64,
        validate_short_name: impl FnOnce() -> Result<()> + 'static,
    ) -> Result<()> {
        self.mutate(expected_revision, move |snippets| {
            if snippets.len() == SNIPPET_MAX_COUNT {
                return Err(SnippetDomainError::new(
                    SnippetErrorCode::LIMIT_REACHED,
                    format!("A maximum of {SNIPPET_MAX_COUNT} snippets is allowed"),
                    409,
                )
                .into());
            }
            if snippets
                .iter()
                .any(|entry| entry.definition.short_name == snippet.definition.short_name)
            {
                return Err(name_conflict(&snippet.definition.short_name).into());
            }
            if snippets.iter().any(|entry| entry.id == snippet.id) {
                return Err(SnippetDomainError::new(
                    SnippetErrorCode::VALIDATION_FAILED,
                    "Snippet ID already exists",
                    409,
                )
                .into());
            }
            validate_short_name()?;
            snippets.push(snippet);
            Ok(())
        })
        .await
    }

    pub async fn update(
        self: &Rc<Self>,
        id: String,
        definition: SnippetDefinitionInput,
        updated_at: String,
        expected_revision: u64,
        validate_short_name: impl FnOnce() -> Result<()> + 'static,
    ) -> Result<()> {
        self.mutate(expected_revision, move |snippets| {
            let index = snippets
                .iter()
                .position(|entry| entry.id == id)
                .ok_or_else(not_found)?;
            if snippets
                .iter()
                .any(|entry| entry.id != id && entry.definition.short_name == definition.short_name)
            {
                return Err(name_conflict(&definition.short_name).into());
            }
            validate_short_name()?;
            let current = &mut snippets[index];
            let previous = date_parse(&current.updated_at).ok_or(InvalidTimeValue)?;
            let candidate = date_parse(&updated_at).ok_or(InvalidTimeValue)?;
            current.updated_at = to_iso_string(candidate.max(previous + 1))?;
            current.definition = definition;
            Ok(())
        })
        .await
    }

    pub async fn remove(self: &Rc<Self>, id: String, expected_revision: u64) -> Result<()> {
        self.mutate(expected_revision, move |snippets| {
            let index = snippets
                .iter()
                .position(|entry| entry.id == id)
                .ok_or_else(not_found)?;
            snippets.remove(index);
            Ok(())
        })
        .await
    }

    async fn mutate(
        self: &Rc<Self>,
        expected_revision: u64,
        change: impl FnOnce(&mut Vec<Snippet>) -> Result<()> + 'static,
    ) -> Result<()> {
        let store = self.clone();
        self.tasks.spawn_local(async move {
            store.lock.run_exclusive(LOCK, || async {
                if store.unknown_durability.get() {
                    return Err(SnippetDomainError::new(SnippetErrorCode::CATALOG_SAVE_UNKNOWN,
                        "The snippets catalog has an unconfirmed save; restart the server before further catalog changes.", 503).into());
                }
                let mut draft = store.file.borrow().clone();
                if draft.revision != expected_revision {
                    let mut error = SnippetDomainError::new(SnippetErrorCode::REVISION_CONFLICT,
                        "Snippets changed in another client; refresh and try again", 409);
                    error.retryable = true;
                    return Err(error.into());
                }
                if draft.revision == MAX_REVISION {
                    return Err(SnippetDomainError::new(SnippetErrorCode::REVISION_EXHAUSTED,
                        "Snippet revision limit reached", 409).into());
                }
                change(&mut draft.snippets)?;
                draft.snippets = sort_snippets_by_short_name(&draft.snippets);
                draft.revision += 1;
                let result = store.writer.write(&store.path, &draft).await;
                let committed_unknown = result.as_ref().is_err_and(|error| error.is::<SnippetCatalogCommittedUnknownError>());
                if result.is_ok() || committed_unknown {
                    *store.file.borrow_mut() = draft;
                    store.unknown_durability.set(committed_unknown);
                }
                result
            }, None).await?
        }).await?
    }
}

fn not_found() -> SnippetDomainError {
    SnippetDomainError::new(SnippetErrorCode::NOT_FOUND, "Snippet not found", 404)
}

fn name_conflict(short_name: &str) -> SnippetDomainError {
    SnippetDomainError::new(
        SnippetErrorCode::NAME_CONFLICT,
        format!("A snippet named {short_name} already exists"),
        409,
    )
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
