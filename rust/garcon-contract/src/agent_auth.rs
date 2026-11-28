//! Ports common/agent-auth.ts.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDeviceAuthInfo {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_code: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuthLoginLaunchResult {
    pub launched: bool,
    pub already_running: bool,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_auth: Option<AgentDeviceAuthInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum AgentAuthLoginStatus {
    Idle {
        running: bool,
    },
    Running {
        running: bool,
        session_id: String,
        completion_pending: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        retryable_error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        device_auth: Option<AgentDeviceAuthInfo>,
    },
    Succeeded {
        running: bool,
        session_id: String,
    },
    Failed {
        running: bool,
        session_id: String,
        error: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuthLoginCompleteResult {
    pub submitted: bool,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum AgentAuthLoginHttpStatus {
    Idle {
        running: bool,
    },
    Running {
        running: bool,
        session_id: String,
        completion_pending: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        retryable_error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        device_auth: Option<AgentDeviceAuthInfo>,
    },
    Succeeded {
        running: bool,
        session_id: String,
        instance_id: String,
    },
    Failed {
        running: bool,
        session_id: String,
        error: String,
    },
}

pub const LOGIN_INSTANCE_QUERY: &str = "loginInstance";
