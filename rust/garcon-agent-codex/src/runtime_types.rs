use std::{fmt, rc::Rc};

use garcon_agents_common::execution::admission::{assert_execution_open, mark_execution_started};
use garcon_contract::{agent_execution::AgentAttachment, chat_modes::ThinkingMode};
use garcon_interface::{execution::AgentExecutionAdmission, resources::ExecutorResult};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Map;

use crate::app_server::{
    operation_routes::CodexOperation,
    request_builders::{CodexThreadConfiguration, ThreadActivationSettings},
};

pub type CodexConfigObject = Map<String, serde_json::Value>;

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderConfig {
    pub config: CodexConfigObject,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<IndexMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_catalog_path: Option<String>,
}
impl fmt::Debug for CodexProviderConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CodexProviderConfig")
            .field("model_catalog_path", &self.model_catalog_path)
            .finish_non_exhaustive()
    }
}

pub struct CodexExecutionRequest {
    pub activation: ThreadActivationSettings,
    pub thinking_mode: Option<ThinkingMode>,
    pub model_endpoint_id: Option<String>,
    pub client_message_id: Option<String>,
    pub admission: Option<Rc<dyn AgentExecutionAdmission>>,
    pub command: String,
    pub images: Vec<AgentAttachment>,
    pub env_overrides: Option<IndexMap<String, String>>,
    pub operation: Rc<CodexOperation>,
}

impl CodexExecutionRequest {
    pub fn thread_configuration(&self) -> CodexThreadConfiguration {
        CodexThreadConfiguration {
            model: self.activation.model.clone(),
            permission_mode: self.activation.permission_mode,
            thinking_mode: self.thinking_mode,
        }
    }

    pub fn assert_open(&self) -> ExecutorResult<()> {
        if let Some(admission) = &self.admission {
            assert_execution_open(admission.as_ref())?;
        }
        Ok(())
    }

    pub async fn mark_started(&self) -> ExecutorResult<()> {
        if let Some(admission) = &self.admission {
            mark_execution_started(admission.as_ref()).await?;
        }
        Ok(())
    }
}

pub struct CodexStartRequest {
    pub execution: CodexExecutionRequest,
    pub on_session_activated: Option<Rc<dyn Fn(CodexStartedSession)>>,
}

pub struct CodexResumeRequest {
    pub execution: CodexExecutionRequest,
    pub agent_session_id: String,
    pub native_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexStartedSession {
    pub agent_session_id: String,
    pub native_path: Option<String>,
}
