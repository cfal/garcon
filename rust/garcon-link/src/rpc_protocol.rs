//! Ports `server/remote/transport/rpc-protocol.ts`.

use garcon_contract::agent_integration::{
    AgentDescriptor, AgentSettingDescriptor, AgentSettingsEnvelope,
};
use garcon_interface::{
    execution_runtime::ExecutorInfo,
    integration::AgentIntegration,
    resources::{AgentResourceScope, ExecutorResult},
    services::{AgentAttachments, AgentLiteralExecution},
};
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::git_protocol::is_git_rpc_method;

pub const EXECUTOR_PROTOCOL_REVISION: u32 = 71;

pub const NULLABLE_AGENT_FACETS: &[&str] = &[
    "readiness",
    "auth",
    "commands",
    "compaction",
    "forking",
    "steering",
    "endpoints",
    "singleQuery",
    "legacyHistoryImport",
    "nativeHistoryImport",
    "nativeActivity",
    "nativeSessions",
    "configurationValidation",
    "sessionConfiguration",
    "projectPathUpdates",
    "usageHistory",
    "cliUpdates",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecutorDescription {
    pub info: ExecutorInfo,
    pub integrations: Vec<IntegrationManifest>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationManifest {
    pub descriptor: AgentDescriptor,
    pub scope: AgentResourceScope,
    pub settings: IntegrationManifestSettings,
    pub attachments: Option<AgentAttachments>,
    pub capabilities: IndexMap<String, bool>,
    pub literal_execution: Option<AgentLiteralExecution>,
    pub auth_methods: IntegrationManifestAuthMethods,
    pub single_query_runs_tools_without_permission: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IntegrationManifestSettings {
    pub descriptors: Vec<AgentSettingDescriptor>,
    pub defaults: AgentSettingsEnvelope,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationManifestAuthMethods {
    pub launch_login: bool,
    pub complete_login: bool,
    pub login_status: bool,
}

impl IntegrationManifest {
    pub fn from_integration(integration: &AgentIntegration) -> ExecutorResult<Self> {
        let settings = IntegrationManifestSettings {
            descriptors: integration.settings.describe().to_vec(),
            defaults: integration.settings.defaults()?,
        };
        let capabilities = [
            integration.readiness.is_some(),
            integration.auth.is_some(),
            integration.commands.is_some(),
            integration.compaction.is_some(),
            integration.forking.is_some(),
            integration.steering.is_some(),
            integration.endpoints.is_some(),
            integration.single_query.is_some(),
            integration.legacy_history_import.is_some(),
            integration.native_history_import.is_some(),
            integration.native_activity.is_some(),
            integration.native_sessions.is_some(),
            integration.configuration_validation.is_some(),
            integration.session_configuration.is_some(),
            integration.project_path_updates.is_some(),
            integration.usage_history.is_some(),
            integration.cli_updates.is_some(),
        ];
        let auth = integration
            .auth
            .as_ref()
            .map(|auth| auth.login_capabilities())
            .unwrap_or_default();
        Ok(Self {
            descriptor: integration.descriptor.clone(),
            scope: integration.producers.scope().clone(),
            settings,
            attachments: integration.attachments.clone(),
            capabilities: NULLABLE_AGENT_FACETS
                .iter()
                .zip(capabilities)
                .map(|(name, present)| ((*name).into(), present))
                .collect(),
            literal_execution: integration.literal_execution.clone(),
            auth_methods: IntegrationManifestAuthMethods {
                launch_login: auth.launch_login.is_some(),
                complete_login: auth.complete_login.is_some(),
                login_status: auth.login_status.is_some(),
            },
            single_query_runs_tools_without_permission: integration
                .single_query
                .as_ref()
                .is_some_and(|facet| facet.runs_tools_without_permission()),
        })
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RpcContinuity {
    Session,
    Launch,
    Journaled,
}

use RpcContinuity::{Journaled, Launch, Session};

const CONTINUITY: &[(&str, RpcContinuity)] = &[
    ("executor.describe", Session),
    ("apiProviders.discoverModels", Journaled),
    ("projects.inspect", Journaled),
    ("projects.ticketProjectDefault", Journaled),
    ("projects.resolveFileMentions", Journaled),
    ("producers.bind", Session),
    ("producers.close", Journaled),
    ("producers.cancelLaunch", Journaled),
    ("producers.resume", Session),
    ("permissions.respond", Journaled),
    ("execution.start", Launch),
    ("execution.resume", Launch),
    ("execution.abort", Journaled),
    ("execution.runningSessions", Journaled),
    ("catalog.snapshot", Journaled),
    ("settings.migrate", Journaled),
    ("lifecycle.start", Session),
    ("lifecycle.stop", Session),
    ("lifecycle.migrateOwnedStorage", Session),
    ("migration.translateLegacyModel", Journaled),
    ("migration.translateLegacyNativeSession", Journaled),
    ("migration.translateLegacySettings", Journaled),
    ("auth.status", Journaled),
    ("readiness.status", Journaled),
    ("auth.launchLogin", Journaled),
    ("auth.completeLogin", Journaled),
    ("auth.loginStatus", Journaled),
    ("commands.discover", Journaled),
    ("compaction.compact", Launch),
    ("forking.fork", Session),
    ("forking.discard", Journaled),
    ("steering.captureTarget", Journaled),
    ("steering.steer", Journaled),
    ("endpoints.validate", Journaled),
    ("singleQuery.run", Journaled),
    ("history.open", Session),
    ("history.next", Session),
    ("history.close", Session),
    ("nativeActivity.lastActivity", Journaled),
    ("nativeSessions.resolveNativeSession", Journaled),
    ("nativeSessions.describeSource", Journaled),
    ("nativeSessions.release", Journaled),
    ("configurationValidation.validate", Journaled),
    ("sessionConfiguration.apply", Journaled),
    ("projectPathUpdates.prepare", Session),
    ("projectPathUpdates.commit", Journaled),
    ("projectPathUpdates.rollback", Journaled),
    ("usageHistory.read", Journaled),
    ("cliUpdates.status", Journaled),
    ("cliUpdates.startUpdate", Journaled),
    ("credentials.resolve", Session),
    ("calls.reconcile", Session),
    ("terminals.list", Session),
    ("terminals.create", Session),
    ("terminals.rename", Session),
    ("terminals.terminate", Session),
    ("terminals.attach", Session),
    ("terminals.input", Session),
    ("terminals.resize", Session),
    ("terminals.detach", Session),
    ("controllerCli.describe", Session),
    ("controllerCli.request", Session),
];

pub const SESSION_INSTALLATION_METHODS: &[&str] = &[
    "executor.describe",
    "lifecycle.migrateOwnedStorage",
    "lifecycle.start",
    "producers.resume",
    "calls.reconcile",
];

pub fn rpc_continuity(method: &str) -> RpcContinuity {
    if method.starts_with("files.") || is_git_rpc_method(method) {
        return Journaled;
    }
    CONTINUITY
        .iter()
        .find(|(name, _)| method == *name)
        .map_or(Session, |(_, mode)| *mode)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename = "request", rename_all = "camelCase", tag = "type")]
pub struct ExecutorRpcRequest {
    pub id: String,
    pub seq: u64,
    pub integration_id: String,
    pub method: String,
    pub request: Opaque,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutstandingCall {
    pub id: String,
    pub session: String,
    pub seq: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OutstandingCallStatus {
    Pending,
    NotReceived,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutstandingCallState {
    pub id: String,
    pub state: OutstandingCallStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename = "reply-ack", tag = "type")]
pub struct ReplyAckFrame {
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename = "producer", tag = "type")]
pub struct AgentProducerFrame<Notification = Opaque> {
    pub seq: u64,
    pub notification: Notification,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProducerAcknowledgement {
    pub binding_id: String,
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProducerResumeState<Handle = Opaque> {
    pub binding_id: String,
    pub replay_through_seq: u64,
    pub launch: Option<ProducerResumeLaunch<Handle>>,
    pub received_run_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProducerResumeLaunch<Handle = Opaque> {
    pub run_id: String,
    pub handle: Option<Handle>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename = "producer-ack", tag = "type")]
pub struct ProducerAckFrame {
    pub acknowledgements: Vec<ProducerAcknowledgement>,
}
