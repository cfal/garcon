//! The HTTP list and executor-change event serialize these producer shapes.
//! The shared `ExecutorSnapshot` remains the typed read shape.

use garcon_contract::executors::{ExecutorKind, ExecutorSnapshot};
use serde::{Serialize, Serializer, ser::SerializeStruct};

use super::ExecutorManager;

pub enum ExecutorSnapshotWire {
    Local(LocalExecutorSnapshotWire),
    Remote(RemoteExecutorSnapshotWire),
}

pub struct LocalExecutorSnapshotWire(ExecutorSnapshot);
pub struct RemoteExecutorSnapshotWire(ExecutorSnapshot);

impl ExecutorManager {
    pub fn list_wire(&self) -> Vec<ExecutorSnapshotWire> {
        self.list()
            .into_iter()
            .map(|snapshot| match snapshot.kind {
                ExecutorKind::Local => {
                    ExecutorSnapshotWire::Local(LocalExecutorSnapshotWire(snapshot))
                }
                ExecutorKind::Remote => {
                    ExecutorSnapshotWire::Remote(RemoteExecutorSnapshotWire(snapshot))
                }
            })
            .collect()
    }
}

impl Serialize for ExecutorSnapshotWire {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Local(snapshot) => snapshot.serialize(serializer),
            Self::Remote(snapshot) => snapshot.serialize(serializer),
        }
    }
}

impl Serialize for LocalExecutorSnapshotWire {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let item = &self.0;
        let mut out = serializer.serialize_struct("LocalExecutorSnapshot", 13)?;
        out.serialize_field("id", &item.id)?;
        out.serialize_field("label", &item.label)?;
        out.serialize_field("kind", &item.kind)?;
        out.serialize_field("enabled", &item.enabled)?;
        out.serialize_field("direction", &item.direction)?;
        out.serialize_field("allowControllerCli", &item.allow_controller_cli)?;
        out.serialize_field("allowExecutorManagement", &item.allow_executor_management)?;
        out.serialize_field("availability", &item.availability)?;
        out.serialize_field("projectBasePath", &item.project_base_path)?;
        out.serialize_field("instanceId", &item.instance_id)?;
        out.serialize_field("bulk", &item.bulk)?;
        out.serialize_field("lastError", &item.last_error)?;
        out.serialize_field("executorServices", &item.executor_services)?;
        out.end()
    }
}

impl Serialize for RemoteExecutorSnapshotWire {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let item = &self.0;
        let mut out = serializer.serialize_struct("RemoteExecutorSnapshot", 13)?;
        out.serialize_field("id", &item.id)?;
        out.serialize_field("label", &item.label)?;
        out.serialize_field("kind", &item.kind)?;
        out.serialize_field("enabled", &item.enabled)?;
        out.serialize_field("allowControllerCli", &item.allow_controller_cli)?;
        out.serialize_field("allowExecutorManagement", &item.allow_executor_management)?;
        out.serialize_field("direction", &item.direction)?;
        out.serialize_field("availability", &item.availability)?;
        out.serialize_field("projectBasePath", &item.project_base_path)?;
        out.serialize_field("lastError", &item.last_error)?;
        out.serialize_field("instanceId", &item.instance_id)?;
        out.serialize_field("bulk", &item.bulk)?;
        out.serialize_field("executorServices", &item.executor_services)?;
        out.end()
    }
}
