//! Ports `server-agents/interface/src/contracts/integration.ts`.

use std::rc::Rc;

use garcon_contract::agent_integration::AgentDescriptor;

use crate::{
    cli_updates::AgentCliUpdates,
    execution::{
        AgentConfigurationValidation, AgentProjectPathUpdates, AgentSessionConfigurationUpdates,
    },
    execution_v5::AgentExecutionV5,
    host::AgentHost,
    native_fork::AgentNativeFork,
    native_history::{AgentHistoryImport, AgentNativeActivityProbe, AgentNativeSessionAccess},
    producer::{AgentPermissions, AgentProducers},
    services::{
        AgentAttachments, AgentAuth, AgentCatalog, AgentCommands, AgentCompaction, AgentEndpoints,
        AgentLifecycle, AgentLiteralExecution, AgentMigration, AgentReadiness, AgentSettings,
        AgentSingleQuery, AgentSteering,
    },
    usage_history::AgentUsageHistory,
};

pub struct AgentIntegration {
    pub descriptor: AgentDescriptor,
    pub literal_execution: Option<AgentLiteralExecution>,
    pub attachments: Option<AgentAttachments>,
    pub execution: Rc<dyn AgentExecutionV5>,
    pub producers: Rc<dyn AgentProducers>,
    pub permissions: Rc<dyn AgentPermissions>,
    pub catalog: Rc<dyn AgentCatalog>,
    pub settings: Rc<dyn AgentSettings>,
    pub lifecycle: Rc<dyn AgentLifecycle>,
    pub migration: Rc<dyn AgentMigration>,
    // The capability order on the executor link.
    pub readiness: Option<Rc<dyn AgentReadiness>>,
    pub auth: Option<Rc<dyn AgentAuth>>,
    pub commands: Option<Rc<dyn AgentCommands>>,
    pub compaction: Option<Rc<dyn AgentCompaction>>,
    pub forking: Option<Rc<dyn AgentNativeFork>>,
    pub steering: Option<Rc<dyn AgentSteering>>,
    pub endpoints: Option<Rc<dyn AgentEndpoints>>,
    pub single_query: Option<Rc<dyn AgentSingleQuery>>,
    pub legacy_history_import: Option<Rc<dyn AgentHistoryImport>>,
    pub native_history_import: Option<Rc<dyn AgentHistoryImport>>,
    pub native_activity: Option<Rc<dyn AgentNativeActivityProbe>>,
    pub native_sessions: Option<Rc<dyn AgentNativeSessionAccess>>,
    pub configuration_validation: Option<Rc<dyn AgentConfigurationValidation>>,
    pub session_configuration: Option<Rc<dyn AgentSessionConfigurationUpdates>>,
    pub project_path_updates: Option<Rc<dyn AgentProjectPathUpdates>>,
    pub usage_history: Option<Rc<dyn AgentUsageHistory>>,
    pub cli_updates: Option<Rc<dyn AgentCliUpdates>>,
}

pub const AGENT_INTEGRATION_API_VERSION: u64 = 5;

pub trait AgentIntegrationClass {
    fn integration_id(&self) -> &str;
    fn api_version(&self) -> u64;
    fn create(&self, host: AgentHost) -> AgentIntegration;
}
