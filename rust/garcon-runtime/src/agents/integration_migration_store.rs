use std::io;
use std::rc::Rc;
use std::task::Poll;

use async_trait::async_trait;
use garcon_base::KeyedLock;
use garcon_base::json_file_store::JsonFileStore;
use garcon_interface::host::{AgentMigrationCommit, AgentMigrationStore};
use garcon_interface::resources::ExecutorResult;
use garcon_js::Number;
use garcon_js::json::{self, Opaque};
use garcon_js::path::native;
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::fs;

thread_local! {
    static LOCKS: Rc<KeyedLock> = Rc::new(KeyedLock::new());
}

#[derive(Clone)]
pub struct FileAgentMigrationStore {
    file_path: String,
}

struct MigrationState {
    version: Number,
    values: Map<String, Value>,
}

impl FileAgentMigrationStore {
    pub fn new(workspace_dir: &str, agent_id: &str) -> Self {
        Self {
            file_path: native::join(&[
                workspace_dir,
                "agent-data",
                agent_id,
                "migration-state.json",
            ]),
        }
    }

    async fn read_state(&self) -> ExecutorResult<MigrationState> {
        let bytes = match fs::read(&self.file_path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(MigrationState {
                    version: Number(0.0),
                    values: Map::new(),
                });
            }
            Err(error) => return Err(error.into()),
        };
        let invalid = || format!("Invalid agent migration state: {}", self.file_path);
        let mut parsed = json::parse(&String::from_utf8_lossy(&bytes)).map_err(|_| invalid())?;
        let version = parsed
            .get("version")
            .and_then(json::as_number)
            .filter(|version| {
                (0.0..=9_007_199_254_740_991.0).contains(version) && version.fract() == 0.0
            })
            .ok_or_else(invalid)?;
        let Some(Value::Object(values)) = parsed
            .as_object_mut()
            .and_then(|object| object.shift_remove("values"))
        else {
            return Err(invalid().into());
        };
        Ok(MigrationState {
            version: Number(version),
            values,
        })
    }

    async fn commit_state(&self, request: AgentMigrationCommit) -> ExecutorResult<()> {
        let mut current = self.read_state().await?;
        if current.version != request.expected_version {
            return Err(format!(
                "Agent migration version changed: expected {}, found {}",
                request.expected_version, current.version,
            )
            .into());
        }
        for (key, value) in request.set {
            current.values.insert(key, value.into_value());
        }
        for key in request.delete {
            current.values.shift_remove(&key);
        }
        #[derive(Serialize)]
        struct StoredState {
            version: Number,
            values: Opaque,
        }
        let state = StoredState {
            version: request.next_version,
            values: Value::Object(current.values).into(),
        };
        JsonFileStore::default()
            .write_json_file_atomic(&self.file_path, &state, Default::default())
            .await?;
        Ok(())
    }
}

#[async_trait(?Send)]
impl AgentMigrationStore for FileAgentMigrationStore {
    async fn get_version(&self) -> ExecutorResult<Number> {
        Ok(self.read_state().await?.version)
    }

    async fn read(&self, key: &str) -> ExecutorResult<Option<Opaque>> {
        Ok(self
            .read_state()
            .await?
            .values
            .shift_remove(key)
            .map(Opaque::from))
    }

    async fn commit(&self, request: AgentMigrationCommit) -> ExecutorResult<()> {
        let store = self.clone();
        let mut write = Box::pin(async move {
            let locks = LOCKS.with(Rc::clone);
            locks
                .run_exclusive(&store.file_path, || store.commit_state(request), None)
                .await?
        });
        // Queues in call order, but the queued write and its lock outlive the caller.
        match futures::poll!(&mut write) {
            Poll::Ready(result) => result,
            Poll::Pending => tokio::task::spawn_local(write).await?,
        }
    }
}

#[cfg(test)]
mod tests;
