//! Ports common/agent-execution.ts.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::api_providers::{ApiProtocol, OpenAiEndpointCapabilities};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttachment {
    pub kind: AgentAttachmentKind,
    pub data: String,
    pub name: Option<String>,
    pub mime_type: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentAttachmentKind {
    Image,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCredentialReference {
    pub kind: AgentCredentialReferenceKind,
    pub api_provider_id: String,
    pub endpoint_id: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentCredentialReferenceKind {
    ApiProviderEndpoint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEndpointSelection {
    pub api_provider_id: String,
    pub endpoint_id: String,
    pub provider_label: String,
    pub protocol: ApiProtocol,
    pub base_url: String,
    pub model: String,
    pub is_local: bool,
    pub capabilities: Option<OpenAiEndpointCapabilities>,
    pub headers: IndexMap<String, String>,
    pub credential: Option<AgentCredentialReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuthStatus {
    pub authenticated: bool,
    pub can_reauth: bool,
    pub label: String,
    pub source: AgentAuthSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentAuthSource {
    Oauth,
    ApiKey,
    Environment,
    Cli,
    None,
    Unknown,
}
