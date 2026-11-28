//! Workspace-local assignment authority. Profile credentials never enter this file.

use std::cell::RefCell;
use std::collections::HashSet;
use std::io;
use std::path::Path;
use std::rc::Rc;

use garcon_base::{
    domain_error::DomainError,
    json_file_store::{JsonFileStore, sync_directory},
    keyed_lock::KeyedLock,
};
use garcon_contract::{
    api_providers::{ApiProviderAssignments, is_api_provider_id},
    error_codes::ErrorCode,
    executors::is_executor_id,
};
use garcon_js::{is_safe_integer, json, path::native};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;
use tokio::{fs, io::AsyncWriteExt};
use tokio_util::task::TaskTracker;

use super::{Listener, Listeners, Result, SnapshotWriter, renamed_write, revision};

const WRITE_LOCK: &str = "assignments";
const ASSIGNMENT_FILE: &str = "api-provider-assignments.json";
const MAX_ASSIGNMENT_EXECUTORS: usize = 1024;
const MAX_PROVIDERS_PER_EXECUTOR: usize = 1024;

pub type AssertAssignmentCurrent = Box<dyn FnOnce() -> Result<()>>;
pub type RetainExecutorReferences =
    Rc<dyn Fn(&[Option<&str>], &[Option<&str>]) -> Result<Box<dyn FnOnce()>>>;

#[derive(Clone, Serialize)]
pub(super) struct AssignmentFile {
    version: u8,
    #[serde(flatten)]
    state: ApiProviderAssignments,
}

pub fn validate_provider_executor_ids(value: &Value) -> Result<Vec<String>> {
    value
        .as_array()
        .filter(|ids| ids.len() <= MAX_ASSIGNMENT_EXECUTORS)
        .and_then(|ids| unique_strings(ids, is_executor_id))
        .ok_or_else(|| {
            DomainError::new_validation("executorIds must be a list of unique executor IDs").into()
        })
}

fn unique_strings(values: &[Value], is_valid: impl Fn(&Value) -> bool) -> Option<Vec<String>> {
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|value| {
            let text = value.as_str()?;
            (is_valid(value) && seen.insert(text)).then(|| text.to_owned())
        })
        .collect()
}

fn parse_assignments(raw: &Value) -> Result<AssignmentFile> {
    let invalid = "Invalid provider assignments";
    let rev = revision(&raw["revision"]).ok_or(invalid)?;
    let entries = raw["assignments"]
        .as_object()
        .filter(|entries| {
            json::as_number(&raw["version"]) == Some(1.0)
                && entries.len() <= MAX_ASSIGNMENT_EXECUTORS
        })
        .ok_or(invalid)?;
    let assignments = entries
        .iter()
        .map(|(executor, value)| {
            let values = value
                .as_array()
                .filter(|ids| {
                    ids.len() <= MAX_PROVIDERS_PER_EXECUTOR
                        && is_executor_id(&Value::String(executor.clone()))
                })
                .and_then(|ids| unique_strings(ids, is_api_provider_id))
                .ok_or("Invalid provider assignment")?;
            Ok((executor.clone(), values))
        })
        .collect::<Result<IndexMap<_, _>>>()?;
    Ok(AssignmentFile {
        version: 1,
        state: ApiProviderAssignments {
            revision: rev,
            assignments,
        },
    })
}

struct Publication {
    assert_current: Option<AssertAssignmentCurrent>,
    retain: RetainExecutorReferences,
    executors: Vec<String>,
}

struct Retention(Option<Box<dyn FnOnce()>>);

impl Drop for Retention {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            release();
        }
    }
}

pub struct ApiProviderAssignmentStore {
    path: String,
    state: RefCell<Option<AssignmentFile>>,
    lock: KeyedLock,
    tasks: TaskTracker,
    listeners: Listeners,
    writer: Rc<dyn SnapshotWriter<AssignmentFile>>,
}

impl ApiProviderAssignmentStore {
    pub async fn initialize_fresh_workspace(workspace: &Path) -> io::Result<()> {
        // An interrupted first write leaves a fail-closed file instead of an absent legacy policy.
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(workspace.join(ASSIGNMENT_FILE)).await?;
        file.write_all(br#"{"version":1,"revision":0,"assignments":{}}"#)
            .await?;
        file.sync_all().await?;
        drop(file);
        sync_directory(workspace).await
    }

    /// Called only by the one-time legacy workspace migration.
    pub async fn migrate(
        workspace: &str,
        executors: &[String],
        providers: &[String],
    ) -> Result<()> {
        let path = native::join(&[workspace, ASSIGNMENT_FILE]);
        let disk = JsonFileStore::default();
        let prior = disk
            .read_json_state_file(&path, || None, |raw| parse_assignments(&raw).map(Some))
            .await?;
        let state = if let Some(prior) = prior {
            prior
        } else {
            let assignments: IndexMap<_, _> = executors
                .iter()
                .map(|executor| (executor, providers))
                .collect();
            parse_assignments(
                &serde_json::json!({ "version": 1, "revision": 0, "assignments": assignments }),
            )?
        };
        disk.write(&path, &state).await
    }

    pub async fn open(workspace: &str) -> Result<Rc<Self>> {
        Self::open_with_writer(workspace, Rc::new(JsonFileStore::default())).await
    }

    pub(super) async fn open_with_writer(
        workspace: &str,
        writer: Rc<dyn SnapshotWriter<AssignmentFile>>,
    ) -> Result<Rc<Self>> {
        let path = native::join(&[workspace, ASSIGNMENT_FILE]);
        let state = JsonFileStore::default()
            .read_json_state_file(&path, || None, |raw| parse_assignments(&raw).map(Some))
            .await?
            .ok_or("Provider assignments are missing. Restore api-provider-assignments.json.")?;
        Ok(Rc::new(Self {
            path,
            state: RefCell::new(Some(state)),
            lock: KeyedLock::new(),
            tasks: TaskTracker::new(),
            listeners: Listeners::default(),
            writer,
        }))
    }

    pub async fn drain(&self) {
        self.tasks.close();
        self.tasks.wait().await;
    }

    pub fn on_changed(&self, listener: Listener) -> impl FnOnce() + use<> {
        self.listeners.subscribe(listener)
    }

    pub fn snapshot(&self) -> Result<ApiProviderAssignments> {
        Ok(self
            .state
            .borrow()
            .as_ref()
            .ok_or_else(storage_unavailable)?
            .state
            .clone())
    }

    pub fn allows(&self, executor: &str, provider: &str) -> Result<bool> {
        Ok(self
            .state
            .borrow()
            .as_ref()
            .ok_or_else(storage_unavailable)?
            .state
            .assignments
            .get(executor)
            .is_some_and(|ids| ids.iter().any(|id| id == provider)))
    }

    pub async fn assign(
        self: &Rc<Self>,
        executor: String,
        provider: String,
        retain: RetainExecutorReferences,
        assert_current: Option<AssertAssignmentCurrent>,
    ) -> Result<()> {
        self.change(
            Some(publication(&executor, retain, assert_current)?),
            move |state| {
                let providers = state.assignments.entry(executor).or_default();
                if !providers.contains(&provider) {
                    providers.push(provider);
                }
            },
        )
        .await
    }

    pub async fn unassign(
        self: &Rc<Self>,
        executor: String,
        provider: String,
        retain: RetainExecutorReferences,
        assert_current: Option<AssertAssignmentCurrent>,
    ) -> Result<()> {
        check_provider_id(&provider)?;
        self.change(
            Some(publication(&executor, retain, assert_current)?),
            move |state| {
                state
                    .assignments
                    .entry(executor)
                    .or_default()
                    .retain(|id| id != &provider);
            },
        )
        .await
    }

    pub async fn remove_provider(self: &Rc<Self>, provider: String) -> Result<()> {
        self.change(None, move |state| {
            for ids in state.assignments.values_mut() {
                ids.retain(|id| id != &provider);
            }
        })
        .await
    }

    pub async fn set_provider_executors(
        self: &Rc<Self>,
        provider: String,
        executors: Vec<String>,
        retain: RetainExecutorReferences,
    ) -> Result<()> {
        check_provider_id(&provider)?;
        validate_provider_executor_ids(&Value::Array(
            executors.iter().cloned().map(Value::String).collect(),
        ))?;
        let guard = Publication {
            assert_current: None,
            retain,
            executors: executors.clone(),
        };
        self.change(Some(guard), move |state| {
            let selected: HashSet<_> = executors.iter().collect();
            for (executor, providers) in &mut state.assignments {
                if !selected.contains(executor) {
                    providers.retain(|id| id != &provider);
                }
            }
            for executor in executors {
                let providers = state.assignments.entry(executor).or_default();
                if !providers.contains(&provider) {
                    providers.push(provider.clone());
                }
            }
        })
        .await
    }

    pub async fn prune(self: &Rc<Self>, configured: Vec<String>) -> Result<()> {
        self.change(None, move |state| {
            let kept: HashSet<_> = configured.into_iter().collect();
            state
                .assignments
                .retain(|id, _| id == "local" || kept.contains(id));
        })
        .await
    }

    async fn change(
        self: &Rc<Self>,
        publication: Option<Publication>,
        mutate: impl FnOnce(&mut ApiProviderAssignments) + 'static,
    ) -> Result<()> {
        let store = self.clone();
        self.tasks
            .spawn_local(async move {
                store
                    .lock
                    .run_exclusive(
                        WRITE_LOCK,
                        || async {
                            let _retained = if let Some(Publication {
                                assert_current,
                                retain,
                                executors,
                            }) = publication
                            {
                                if let Some(assert_current) = assert_current {
                                    assert_current()?;
                                }
                                let next: Vec<_> =
                                    executors.iter().map(|id| Some(id.as_str())).collect();
                                Retention(Some(retain(&next, &[])?))
                            } else {
                                Retention(None)
                            };
                            let before = store.snapshot()?;
                            let mut state = before.clone();
                            mutate(&mut state);
                            if state == before {
                                return Ok(());
                            }
                            state.revision += 1;
                            store.save(AssignmentFile { version: 1, state }).await
                        },
                        None,
                    )
                    .await?
            })
            .await?
    }

    async fn save(&self, candidate: AssignmentFile) -> Result<()> {
        let assignments = &candidate.state.assignments;
        if !is_safe_integer(candidate.state.revision as f64)
            || assignments.len() > MAX_ASSIGNMENT_EXECUTORS
        {
            return Err("Invalid provider assignments".into());
        }
        for (executor, providers) in assignments {
            if providers.len() > MAX_PROVIDERS_PER_EXECUTOR
                || !is_executor_id(&Value::String(executor.clone()))
                || providers
                    .iter()
                    .any(|id| !is_api_provider_id(&Value::String(id.clone())))
            {
                return Err("Invalid provider assignment".into());
            }
        }
        if let Err(error) = self.writer.write(&self.path, &candidate).await {
            if renamed_write(error.as_ref()) {
                self.state.replace(None);
                self.listeners.publish()?;
            }
            return Err(error);
        }
        self.state.replace(Some(candidate));
        self.listeners.publish()
    }
}

fn publication(
    executor: &str,
    retain: RetainExecutorReferences,
    assert_current: Option<AssertAssignmentCurrent>,
) -> Result<Publication> {
    if !is_executor_id(&Value::String(executor.into())) {
        return Err(DomainError::new_validation("Invalid executor").into());
    }
    Ok(Publication {
        assert_current,
        retain,
        executors: vec![executor.into()],
    })
}

fn check_provider_id(provider: &str) -> Result<()> {
    if !is_api_provider_id(&Value::String(provider.into())) {
        return Err(DomainError::new_validation("Invalid provider ID").into());
    }
    Ok(())
}

fn storage_unavailable() -> DomainError {
    DomainError::new(
        ErrorCode::API_PROVIDER_STORAGE_UNAVAILABLE,
        "Provider assignments are unavailable. Reload the controller after restoring configuration.",
        503,
        false,
    )
}
