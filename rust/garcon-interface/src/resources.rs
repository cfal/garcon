//! Ports `server-agents/interface/src/contracts/resources.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::errors::{AgentCallError, AgentDeliveryOutcome, AgentIntegrationErrorCode};

pub type ExecutorResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Debug, Clone, Default)]
pub struct ExecutorCallOptions {
    pub signal: Option<CancellationToken>,
    pub timeout_ms: Option<f64>,
    pub dispatch_deadline: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResourceScope {
    pub executor_id: String,
    pub instance_id: String,
    pub integration_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstanceCallOptions {
    pub expected_scope: AgentResourceScope,
}

pub fn assert_agent_resource_scope(
    actual: &AgentResourceScope,
    expected: &AgentResourceScope,
) -> Result<(), Box<AgentCallError>> {
    if actual != expected {
        return Err(Box::new(AgentCallError::with_code(
            AgentDeliveryOutcome::NotDispatched,
            "The agent resource belongs to a different executor instance",
            AgentIntegrationErrorCode::STALE_RESOURCE,
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AgentResourceRef<K = String> {
    #[serde(flatten)]
    pub scope: AgentResourceScope,
    pub kind: K,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentProducerBindingKind {
    Producer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentPermissionResponseKind {
    PermissionResponse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentProjectPathPreparationKind {
    ProjectPathPreparation,
}

pub type AgentProducerBinding = AgentResourceRef<AgentProducerBindingKind>;
pub type AgentPermissionResponseRef = AgentResourceRef<AgentPermissionResponseKind>;
pub type AgentProjectPathPreparation = AgentResourceRef<AgentProjectPathPreparationKind>;

pub fn create_agent_resource_ref<K>(
    scope: AgentResourceScope,
    kind: K,
    random_uuid: impl FnOnce() -> String,
) -> AgentResourceRef<K> {
    AgentResourceRef {
        scope,
        kind,
        id: random_uuid(),
    }
}

pub fn is_agent_resource_ref(
    value: &Value,
    kind: &str,
    scope: Option<&AgentResourceScope>,
) -> bool {
    let Some(value) = value.as_object() else {
        return false;
    };
    let read = |key: &str| value.get(key).and_then(Value::as_str);
    read("kind") == Some(kind)
        && ["executorId", "instanceId", "integrationId", "id"]
            .into_iter()
            .all(|key| read(key).is_some_and(|text| !text.is_empty()))
        && scope.is_none_or(|scope| {
            read("executorId") == Some(scope.executor_id.as_str())
                && read("instanceId") == Some(scope.instance_id.as_str())
                && read("integrationId") == Some(scope.integration_id.as_str())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fences_every_scope_field_and_preserves_the_delivery_outcome() {
        let expected = AgentResourceScope {
            executor_id: "local".into(),
            instance_id: "instance-1".into(),
            integration_id: "claude".into(),
        };
        assert_agent_resource_scope(&expected, &expected).unwrap();
        for actual in [
            AgentResourceScope {
                executor_id: "remote-1".into(),
                ..expected.clone()
            },
            AgentResourceScope {
                instance_id: "instance-2".into(),
                ..expected.clone()
            },
            AgentResourceScope {
                integration_id: "codex".into(),
                ..expected.clone()
            },
        ] {
            let error = assert_agent_resource_scope(&actual, &expected).unwrap_err();
            assert_eq!(error.code, AgentIntegrationErrorCode::STALE_RESOURCE);
            assert_eq!(error.outcome, AgentDeliveryOutcome::NotDispatched);
        }
    }

    #[test]
    fn creates_a_resource_with_the_injected_id_and_the_exact_kind() {
        let scope = AgentResourceScope {
            executor_id: "local".into(),
            instance_id: "instance-1".into(),
            integration_id: "claude".into(),
        };
        let resource =
            create_agent_resource_ref(scope.clone(), AgentProducerBindingKind::Producer, || {
                "11111111-1111-4111-8111-111111111111".into()
            });
        let wire = serde_json::to_value(resource).unwrap();
        assert!(is_agent_resource_ref(&wire, "producer", Some(&scope)));
        assert!(!is_agent_resource_ref(
            &wire,
            "permission-response",
            Some(&scope)
        ));
        assert!(!is_agent_resource_ref(&json!("producer"), "producer", None));
    }
}
