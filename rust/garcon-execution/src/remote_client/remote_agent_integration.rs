//! Ports the facets of `server/remote/client/remote-agent-integration.ts`.

use std::{cell::Cell, rc::Rc};

use async_trait::async_trait;
use garcon_base::log::Logger;
use garcon_contract::{
    agent_auth::{AgentAuthLoginCompleteResult, AgentAuthLoginLaunchResult, AgentAuthLoginStatus},
    agent_cli_update::{AgentCliUpdateStatus, parse_agent_cli_update_status},
    agent_execution::{AgentAuthStatus, AgentEndpointSelection},
    agent_integration::{AgentSettingDescriptor, AgentSettingsEnvelope},
    input_format::is_input_format_by_model,
    slash_commands::SlashCommand,
    usage::{AgentUsageReport, parse_agent_usage_report},
};
use garcon_interface::{
    cli_updates::{AgentCliUpdateStatusRequest, AgentCliUpdates},
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    execution::{
        AgentConfigurationValidation, AgentPrepareProjectPathUpdateRequest,
        AgentPreparedProjectPathUpdate, AgentProjectPathUpdates, AgentRunningSession,
        AgentSessionConfiguration, AgentSessionConfigurationUpdate,
        AgentSessionConfigurationUpdates,
    },
    execution_v5::{
        AgentExecutionHandle, AgentExecutionV5, AgentResumeRequestV5, AgentStartRequestV5,
    },
    integration::AgentIntegration,
    native_fork::{AgentNativeFork, AgentNativeForkOutcome, AgentNativeForkRequest},
    native_history::{
        AgentHistoryImportRequest, AgentNativeActivityProbe, AgentNativeActivityResult,
        AgentNativeSessionAccess, AgentNativeSessionReleaseRequest,
    },
    producer::{AgentEstablishedSession, AgentPermissionRespondRequest, AgentPermissions},
    resources::{
        AgentInstanceCallOptions, AgentProjectPathPreparation, ExecutorCallOptions, ExecutorResult,
        assert_agent_resource_scope,
    },
    services::*,
    transcript::{AgentNativeSessionRef, AgentTranscriptSourceLocation},
    usage_history::{AgentUsageHistory, AgentUsageReadRequest},
    versioned_settings::VersionedSettings,
};
use garcon_js::{is_safe_integer, json::Opaque};
use garcon_link::{
    message_session::SessionError, rpc::RpcCallOptions, rpc_lane::RpcLane,
    rpc_protocol::IntegrationManifest,
};
use indexmap::IndexMap;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    remote_history::{HistorySource, RemoteHistory},
    remote_producers::RemoteProducers,
    sessions::{HeldCallOptions, RemoteSessionBacking, RemoteSessions, not_dispatched},
    wire::{decode, encode, own_rpc_error},
};

const SINGLE_QUERY_RPC_GRACE_MS: f64 = 30_000.0;
const PERMISSION_RESPONSE_TIMEOUT_MS: f64 = 20_000.0;

pub(super) struct RemoteAgentIntegration {
    state: Rc<RemoteFacetClient>,
    api: Rc<AgentIntegration>,
}

impl RemoteAgentIntegration {
    pub fn new(
        manifest: IntegrationManifest,
        sessions: Rc<RemoteSessions>,
        logger: Rc<dyn Logger>,
    ) -> ExecutorResult<Rc<Self>> {
        if let Some(literal) = &manifest.literal_execution
            && !is_input_format_by_model(encode(&literal.input_format_by_model)?.as_value())
        {
            return Err("Invalid literal input formats in executor manifest".into());
        }
        let id = &manifest.descriptor.id;
        let producers = RemoteProducers::new(id.clone(), sessions.clone(), logger);
        let settings = VersionedSettings::new(
            AgentSettingsEnvelope {
                owner_id: id.clone(),
                ..manifest.settings.defaults.clone()
            },
            manifest.settings.descriptors.clone(),
            None,
        );
        let state = Rc::new(RemoteFacetClient {
            manifest,
            sessions,
            producers: producers.clone(),
            settings,
            migrated: Cell::new(false),
            started: Cell::new(false),
        });
        let manifest = &state.manifest;
        let capability = |name: &str| manifest.capabilities.get(name).copied().unwrap_or(false);
        let history = |source| {
            Rc::new(RemoteHistory {
                sessions: state.sessions.clone(),
                integration_id: manifest.descriptor.id.clone(),
                source,
            })
        };
        macro_rules! facet {
            ($name:literal, $facet:ident) => {
                capability($name).then(|| -> Rc<dyn $facet> { state.clone() })
            };
        }
        let api = Rc::new(AgentIntegration {
            descriptor: manifest.descriptor.clone(),
            literal_execution: manifest.literal_execution.clone(),
            attachments: manifest.attachments.clone(),
            execution: state.clone(),
            producers,
            permissions: state.clone(),
            catalog: state.clone(),
            settings: state.clone(),
            lifecycle: state.clone(),
            migration: state.clone(),
            readiness: facet!("readiness", AgentReadiness),
            auth: capability("auth")
                .then(|| Rc::new(RemoteAuth(state.clone())) as Rc<dyn AgentAuth>),
            commands: facet!("commands", AgentCommands),
            compaction: facet!("compaction", AgentCompaction),
            forking: facet!("forking", AgentNativeFork),
            steering: facet!("steering", AgentSteering),
            endpoints: facet!("endpoints", AgentEndpoints),
            single_query: facet!("singleQuery", AgentSingleQuery),
            legacy_history_import: capability("legacyHistoryImport").then(|| {
                history(HistorySource::LegacyHistoryImport)
                    as Rc<dyn garcon_interface::native_history::AgentHistoryImport>
            }),
            native_history_import: capability("nativeHistoryImport").then(|| {
                history(HistorySource::NativeHistoryImport)
                    as Rc<dyn garcon_interface::native_history::AgentHistoryImport>
            }),
            native_activity: facet!("nativeActivity", AgentNativeActivityProbe),
            native_sessions: facet!("nativeSessions", AgentNativeSessionAccess),
            configuration_validation: facet!(
                "configurationValidation",
                AgentConfigurationValidation
            ),
            session_configuration: facet!("sessionConfiguration", AgentSessionConfigurationUpdates),
            project_path_updates: facet!("projectPathUpdates", AgentProjectPathUpdates),
            usage_history: facet!("usageHistory", AgentUsageHistory),
            cli_updates: facet!("cliUpdates", AgentCliUpdates),
        });
        Ok(Rc::new(Self { state, api }))
    }

    pub fn api(&self) -> Rc<AgentIntegration> {
        self.api.clone()
    }

    pub fn manifest(&self) -> &IntegrationManifest {
        &self.state.manifest
    }

    pub async fn initialize_replacement(
        &self,
        backing: &RemoteSessionBacking,
        initial: bool,
    ) -> Result<(), SessionError> {
        let rpc = &backing.rpc;
        let id = self.state.id();
        if initial || self.state.migrated.get() {
            rpc.call(
                id,
                "lifecycle.migrateOwnedStorage",
                Opaque::from_value(Value::Null),
                RpcCallOptions::default(),
            )
            .await?;
        }
        if initial || self.state.started.get() {
            rpc.call(
                id,
                "lifecycle.start",
                Opaque::from_value(Value::Null),
                RpcCallOptions::default(),
            )
            .await?;
        }
        if initial {
            self.state.migrated.set(true);
            self.state.started.set(true);
        }
        Ok(())
    }

    pub fn retire(&self) {
        self.state.producers.retire();
    }

    pub async fn resume(&self, backing: &Rc<RemoteSessionBacking>) -> Result<(), SessionError> {
        self.state.producers.resume(backing).await
    }

    pub fn receive(
        &self,
        value: Opaque,
        seq: u64,
        backing: &Rc<RemoteSessionBacking>,
    ) -> Result<(), SessionError> {
        self.state.producers.receive(value, seq, backing)
    }
}

struct RemoteFacetClient {
    manifest: IntegrationManifest,
    sessions: Rc<RemoteSessions>,
    producers: Rc<RemoteProducers>,
    settings: VersionedSettings,
    migrated: Cell<bool>,
    started: Cell<bool>,
}

impl RemoteFacetClient {
    fn id(&self) -> &str {
        &self.manifest.descriptor.id
    }

    fn expected_instance(
        &self,
        options: Option<AgentInstanceCallOptions>,
    ) -> ExecutorResult<Option<String>> {
        if let Some(options) = options {
            assert_agent_resource_scope(&self.sessions.scope(self.id())?, &options.expected_scope)
                .map_err(|error| *error)?;
            Ok(Some(options.expected_scope.instance_id))
        } else {
            Ok(None)
        }
    }

    async fn call_raw(
        &self,
        method: &str,
        request: impl Serialize,
        options: HeldCallOptions,
    ) -> ExecutorResult<Option<Opaque>> {
        self.sessions
            .call(self.id(), method, encode(request)?, options)
            .await
    }

    async fn call<R: DeserializeOwned>(
        &self,
        method: &str,
        request: impl Serialize,
        options: impl Into<HeldCallOptions>,
    ) -> ExecutorResult<R> {
        let reply = self.call_raw(method, request, options.into()).await?;
        decode(reply.as_ref())
    }

    async fn new_resource<T: DeserializeOwned + 'static>(
        &self,
        method: &str,
        request: impl Serialize,
        options: HeldCallOptions,
        cleanup_method: &'static str,
        cleanup: impl Fn(T) -> ExecutorResult<Option<Opaque>> + 'static,
    ) -> ExecutorResult<T> {
        let held = self.sessions.acquire(RpcLane::Primary, &options).await?;
        let rpc = &held.backing.rpc;
        let mut call = held.rpc_options(&options);
        let owner = Rc::downgrade(rpc);
        let id = self.id().to_owned();
        let cleanup = Rc::new(cleanup);
        call.on_late_result = Some(Rc::new(move |reply| {
            let rpc = owner.upgrade();
            let id = id.clone();
            let cleanup = cleanup.clone();
            Box::pin(async move {
                if let Some(rpc) = rpc {
                    let reply = decode(reply.as_ref()).map_err(Rc::from)?;
                    if let Some(request) = cleanup(reply).map_err(Rc::from)? {
                        // Cleanup first uses the captured session; only its
                        // journal may reconcile it on the same worker instance.
                        rpc.call(&id, cleanup_method, request, RpcCallOptions::default())
                            .await?;
                    }
                }
                Ok(())
            })
        }));
        let reply = rpc
            .call(self.id(), method, encode(request)?, call)
            .await
            .map_err(own_rpc_error)?;
        decode(reply.as_ref())
    }
}

#[async_trait(?Send)]
impl AgentExecutionV5 for RemoteFacetClient {
    async fn start(
        &self,
        request: AgentStartRequestV5,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        self.producers
            .launch(
                "execution.start",
                &request.context.producer_binding,
                &request.context.run_id,
                encode(&request)?,
                options,
            )
            .await
    }

    async fn resume(
        &self,
        request: AgentResumeRequestV5,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        self.producers
            .launch(
                "execution.resume",
                &request.context.producer_binding,
                &request.context.run_id,
                encode(&request)?,
                options,
            )
            .await
    }

    async fn abort(
        &self,
        handle: AgentExecutionHandle,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<bool> {
        self.call("execution.abort", handle, options).await
    }

    async fn running_sessions(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Vec<AgentRunningSession>> {
        self.call("execution.runningSessions", (), options).await
    }
}

#[async_trait(?Send)]
impl AgentCompaction for RemoteFacetClient {
    async fn compact(
        &self,
        request: AgentResumeRequestV5,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        self.producers
            .launch(
                "compaction.compact",
                &request.context.producer_binding,
                &request.context.run_id,
                encode(&request)?,
                options,
            )
            .await
    }
}

#[async_trait(?Send)]
impl AgentPermissions for RemoteFacetClient {
    async fn respond(
        &self,
        request: AgentPermissionRespondRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        let mut options = options.unwrap_or_default();
        let timeout = options.timeout_ms.unwrap_or(PERMISSION_RESPONSE_TIMEOUT_MS);
        if !is_safe_integer(timeout) || timeout <= 0.0 {
            return Err(garcon_base::errors::NamedError {
                name: "TypeError".into(),
                code: None,
                message: "Permission timeout must be a positive safe integer".into(),
            }
            .into());
        }
        options.timeout_ms = Some(timeout.min(PERMISSION_RESPONSE_TIMEOUT_MS));
        self.call("permissions.respond", request, Some(options))
            .await
    }
}

#[async_trait(?Send)]
impl AgentCatalog for RemoteFacetClient {
    async fn snapshot(&self, request: AgentCatalogRequest) -> ExecutorResult<AgentCatalogSnapshot> {
        let options = Some(ExecutorCallOptions {
            signal: Some(request.signal.clone()),
            timeout_ms: request.timeout_ms,
            dispatch_deadline: request.dispatch_deadline,
        });
        self.call("catalog.snapshot", request, options).await
    }
}

#[async_trait(?Send)]
impl AgentSettings for RemoteFacetClient {
    fn describe(&self) -> &[AgentSettingDescriptor] {
        self.settings.describe()
    }
    fn defaults(&self) -> ExecutorResult<AgentSettingsEnvelope> {
        self.settings.defaults()
    }
    fn parse(&self, input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope> {
        self.settings.parse(input)
    }
    async fn migrate(&self, input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope> {
        self.call("settings.migrate", input, None).await
    }
    fn apply_patch(
        &self,
        current: AgentSettingsEnvelope,
        patch: IndexMap<String, Opaque>,
    ) -> ExecutorResult<AgentSettingsEnvelope> {
        self.settings.apply_patch(current, patch)
    }
}

#[async_trait(?Send)]
impl AgentLifecycle for RemoteFacetClient {
    async fn start(&self) -> ExecutorResult<()> {
        if !self.started.get() {
            self.call::<()>("lifecycle.start", (), None).await?;
            self.started.set(true);
        }
        Ok(())
    }

    async fn stop(&self) -> ExecutorResult<()> {
        self.started.set(false);
        self.call("lifecycle.stop", (), None).await
    }

    async fn migrate_owned_storage(&self) -> ExecutorResult<()> {
        if !self.migrated.get() {
            self.call::<()>("lifecycle.migrateOwnedStorage", (), None)
                .await?;
            self.migrated.set(true);
        }
        Ok(())
    }
}

#[async_trait(?Send)]
impl AgentMigration for RemoteFacetClient {
    async fn translate_legacy_model(
        &self,
        request: AgentTranslateLegacyModelRequest,
    ) -> ExecutorResult<String> {
        let options = with_signal(request.signal.clone());
        self.call("migration.translateLegacyModel", request, options)
            .await
    }

    async fn translate_legacy_native_session(
        &self,
        request: AgentTranslateLegacyNativeSessionRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        let options = with_signal(request.signal.clone());
        self.call("migration.translateLegacyNativeSession", request, options)
            .await
    }

    async fn translate_legacy_settings(
        &self,
        request: AgentTranslateLegacySettingsRequest,
    ) -> ExecutorResult<Option<AgentSettingsEnvelope>> {
        let options = with_signal(request.signal.clone());
        self.call("migration.translateLegacySettings", request, options)
            .await
    }
}

#[async_trait(?Send)]
impl AgentReadiness for RemoteFacetClient {
    async fn status(&self, signal: CancellationToken) -> ExecutorResult<AgentReadinessStatus> {
        self.call("readiness.status", (), with_signal(signal)).await
    }
}

struct RemoteAuth(Rc<RemoteFacetClient>);

#[async_trait(?Send)]
impl AgentAuth for RemoteAuth {
    async fn status(&self, signal: CancellationToken) -> ExecutorResult<AgentAuthStatus> {
        self.0.call("auth.status", (), with_signal(signal)).await
    }

    fn login_capabilities(&self) -> AgentAuthLoginCapabilities {
        let methods = &self.0.manifest.auth_methods;
        AgentAuthLoginCapabilities {
            launch_login: methods
                .launch_login
                .then(|| self.0.clone() as Rc<dyn AgentAuthLaunchLogin>),
            complete_login: methods
                .complete_login
                .then(|| self.0.clone() as Rc<dyn AgentAuthCompleteLogin>),
            login_status: methods
                .login_status
                .then(|| self.0.clone() as Rc<dyn AgentAuthLoginStatusReader>),
        }
    }
}

#[async_trait(?Send)]
impl AgentAuthLaunchLogin for RemoteFacetClient {
    async fn launch_login(&self) -> ExecutorResult<AgentAuthLoginLaunchResult> {
        self.call("auth.launchLogin", (), None).await
    }
}

#[async_trait(?Send)]
impl AgentAuthCompleteLogin for RemoteFacetClient {
    async fn complete_login(
        &self,
        session_id: &str,
        code: &str,
    ) -> ExecutorResult<AgentAuthLoginCompleteResult> {
        self.call(
            "auth.completeLogin",
            json!({"sessionId": session_id, "code": code}),
            None,
        )
        .await
    }
}

#[async_trait(?Send)]
impl AgentAuthLoginStatusReader for RemoteFacetClient {
    async fn login_status(
        &self,
        expected_session_id: Option<&str>,
    ) -> ExecutorResult<AgentAuthLoginStatus> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct LoginStatus<'a> {
            #[serde(skip_serializing_if = "Option::is_none")]
            expected_session_id: Option<&'a str>,
        }
        self.call(
            "auth.loginStatus",
            LoginStatus {
                expected_session_id,
            },
            None,
        )
        .await
    }
}

#[async_trait(?Send)]
impl AgentCommands for RemoteFacetClient {
    async fn discover(
        &self,
        project_path: &str,
        signal: CancellationToken,
    ) -> ExecutorResult<Vec<SlashCommand>> {
        self.call(
            "commands.discover",
            json!({"projectPath": project_path}),
            with_signal(signal),
        )
        .await
    }
}

#[async_trait(?Send)]
impl AgentNativeFork for RemoteFacetClient {
    async fn fork(
        &self,
        request: AgentNativeForkRequest,
        options: Option<AgentInstanceCallOptions>,
    ) -> ExecutorResult<AgentNativeForkOutcome> {
        let options = HeldCallOptions {
            signal: Some(request.signal.clone()),
            instance_id: self.expected_instance(options)?,
            ..Default::default()
        };
        self.new_resource(
            "forking.fork",
            request,
            options,
            "forking.discard",
            |outcome| match outcome {
                AgentNativeForkOutcome::Materialized { session } => encode(session).map(Some),
                AgentNativeForkOutcome::Unmaterialized => Ok(None),
            },
        )
        .await
    }

    async fn discard(
        &self,
        session: AgentEstablishedSession,
        signal: CancellationToken,
        options: Option<AgentInstanceCallOptions>,
    ) -> ExecutorResult<()> {
        let options = HeldCallOptions {
            signal: Some(signal),
            instance_id: self.expected_instance(options)?,
            ..Default::default()
        };
        self.call("forking.discard", session, options).await
    }
}

#[async_trait(?Send)]
impl AgentSteering for RemoteFacetClient {
    async fn capture_target(
        &self,
        request: AgentSteerTargetRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Option<AgentSteerTarget>> {
        self.call("steering.captureTarget", request, options).await
    }

    async fn steer(
        &self,
        request: AgentSteerRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentSteerResult> {
        self.call("steering.steer", request, options).await
    }
}

#[async_trait(?Send)]
impl AgentEndpoints for RemoteFacetClient {
    async fn validate(
        &self,
        request: AgentEndpointSelection,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        self.call("endpoints.validate", request, options).await
    }
}

#[async_trait(?Send)]
impl AgentSingleQuery for RemoteFacetClient {
    async fn run(&self, request: AgentSingleQueryRequest) -> ExecutorResult<String> {
        let timeout = request.timeout_ms.map_or(120_000.0, |timeout| timeout.0);
        if !(timeout > 0.0 && timeout <= f64::from(i32::MAX) - SINGLE_QUERY_RPC_GRACE_MS) {
            return Err(not_dispatched("Single-query timeout is invalid").into());
        }
        let options = Some(ExecutorCallOptions {
            signal: Some(request.signal.clone()),
            timeout_ms: Some(timeout + SINGLE_QUERY_RPC_GRACE_MS),
            dispatch_deadline: None,
        });
        self.call("singleQuery.run", request, options).await
    }

    fn runs_tools_without_permission(&self) -> bool {
        self.manifest.single_query_runs_tools_without_permission
    }
}

#[async_trait(?Send)]
impl AgentNativeActivityProbe for RemoteFacetClient {
    async fn last_activity(
        &self,
        native_session: AgentNativeSessionRef,
        signal: CancellationToken,
    ) -> ExecutorResult<AgentNativeActivityResult> {
        self.call(
            "nativeActivity.lastActivity",
            native_session,
            with_signal(signal),
        )
        .await
    }
}

#[async_trait(?Send)]
impl AgentNativeSessionAccess for RemoteFacetClient {
    async fn resolve_native_session(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        let options = with_signal(request.signal.clone());
        self.call("nativeSessions.resolveNativeSession", request, options)
            .await
    }

    async fn describe_source(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentTranscriptSourceLocation>> {
        let options = with_signal(request.signal.clone());
        self.call("nativeSessions.describeSource", request, options)
            .await
    }

    async fn release(&self, request: AgentNativeSessionReleaseRequest) -> ExecutorResult<()> {
        let options = with_signal(request.request.signal.clone());
        self.call("nativeSessions.release", request, options).await
    }
}

#[async_trait(?Send)]
impl AgentConfigurationValidation for RemoteFacetClient {
    async fn validate(
        &self,
        request: AgentSessionConfiguration,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        self.call("configurationValidation.validate", request, options)
            .await
    }
}

#[async_trait(?Send)]
impl AgentSessionConfigurationUpdates for RemoteFacetClient {
    async fn apply(
        &self,
        agent_session_id: &str,
        configuration: AgentSessionConfigurationUpdate,
        previous_configuration: AgentSessionConfiguration,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        #[derive(Serialize)]
        struct Apply<'a> {
            args: (
                &'a str,
                AgentSessionConfigurationUpdate,
                AgentSessionConfiguration,
            ),
        }
        self.call(
            "sessionConfiguration.apply",
            Apply {
                args: (agent_session_id, configuration, previous_configuration),
            },
            options,
        )
        .await
    }
}

#[async_trait(?Send)]
impl AgentProjectPathUpdates for RemoteFacetClient {
    async fn prepare(
        &self,
        request: AgentPrepareProjectPathUpdateRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Option<AgentPreparedProjectPathUpdate>> {
        self.new_resource(
            "projectPathUpdates.prepare",
            request,
            options.into(),
            "projectPathUpdates.rollback",
            |prepared: Option<AgentPreparedProjectPathUpdate>| {
                prepared
                    .map(|prepared| encode(prepared.preparation))
                    .transpose()
            },
        )
        .await
    }

    async fn commit(
        &self,
        preparation: AgentProjectPathPreparation,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        self.call("projectPathUpdates.commit", preparation, options)
            .await
    }

    async fn rollback(
        &self,
        preparation: AgentProjectPathPreparation,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        self.call("projectPathUpdates.rollback", preparation, options)
            .await
    }
}

#[async_trait(?Send)]
impl AgentUsageHistory for RemoteFacetClient {
    async fn read(&self, request: AgentUsageReadRequest) -> ExecutorResult<AgentUsageReport> {
        let options = Some(ExecutorCallOptions {
            signal: request.signal.clone(),
            ..Default::default()
        });
        let reply = self
            .call_raw("usageHistory.read", request, options.into())
            .await?;
        parse_agent_usage_report(reply.as_deref().unwrap_or(&Value::Null))
            .ok_or_else(|| provider_failure("Executor returned an invalid usage report").into())
    }
}

#[async_trait(?Send)]
impl AgentCliUpdates for RemoteFacetClient {
    async fn status(
        &self,
        request: AgentCliUpdateStatusRequest,
    ) -> ExecutorResult<AgentCliUpdateStatus> {
        let options = Some(ExecutorCallOptions {
            signal: request.signal.clone(),
            ..Default::default()
        });
        let reply = self
            .call_raw("cliUpdates.status", request, options.into())
            .await?;
        cli_update(reply)
    }

    async fn start_update(&self) -> ExecutorResult<AgentCliUpdateStatus> {
        cli_update(
            self.call_raw("cliUpdates.startUpdate", (), HeldCallOptions::default())
                .await?,
        )
    }
}

fn cli_update(reply: Option<Opaque>) -> ExecutorResult<AgentCliUpdateStatus> {
    parse_agent_cli_update_status(reply.as_deref().unwrap_or(&Value::Null))
        .ok_or_else(|| provider_failure("Executor returned an invalid CLI update status").into())
}

fn provider_failure(message: &str) -> AgentIntegrationError {
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::PROVIDER_FAILURE,
        message,
        false,
        None,
    )
}

fn with_signal(signal: CancellationToken) -> HeldCallOptions {
    HeldCallOptions {
        signal: Some(signal),
        ..Default::default()
    }
}
