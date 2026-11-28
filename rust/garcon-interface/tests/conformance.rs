use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use async_trait::async_trait;
use futures::{channel::oneshot, executor::block_on, poll};
use garcon_contract::{
    agent_integration::{
        AgentDescriptor, AgentSettingDescriptor, AgentSettingKind, AgentSettingsEnvelope,
    },
    attachments::FileAttachmentMimeTypes,
    chat_modes::PermissionMode,
};
use garcon_interface::{
    execution::AgentRunningSession,
    execution_v5::{
        AgentExecutionHandle, AgentExecutionKind, AgentExecutionV5, AgentResumeRequestV5,
        AgentStartRequestV5,
    },
    integration::{AGENT_INTEGRATION_API_VERSION, AgentIntegration},
    producer::{
        AgentPermissionRespondRequest, AgentPermissions, AgentProducerBindRequest,
        AgentProducerNotification, AgentProducers,
    },
    resources::{
        AgentProducerBinding, AgentResourceRef, AgentResourceScope, ExecutorCallOptions,
        ExecutorResult,
    },
    services::*,
    testing::{
        AgentIntegrationConformanceOptions, run_agent_integration_conformance,
        validate_agent_integration,
    },
    transcript::AgentNativeSessionRef,
};
use garcon_js::{Number, json::Opaque};
use indexmap::IndexMap;

enum Snapshot {
    Ready(Vec<AgentRunningSession>),
    Failed,
    Pending(oneshot::Receiver<Vec<AgentRunningSession>>),
}

struct TestAgent {
    scope: AgentResourceScope,
    snapshot: RefCell<Snapshot>,
    calls: RefCell<Vec<&'static str>>,
    settings_values: Opaque,
    settings_descriptors: Vec<AgentSettingDescriptor>,
    migrations: Cell<u32>,
    second_migration_values: Option<Opaque>,
    patch_values: Option<Opaque>,
}

impl TestAgent {
    fn handle(&self) -> AgentExecutionHandle {
        AgentResourceRef {
            scope: self.scope.clone(),
            kind: AgentExecutionKind::Execution,
            id: "fixture-execution".into(),
        }
    }
}

#[async_trait(?Send)]
impl AgentExecutionV5 for TestAgent {
    async fn start(
        &self,
        _request: AgentStartRequestV5,
        _options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        Ok(self.handle())
    }
    async fn resume(
        &self,
        _request: AgentResumeRequestV5,
        _options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        Ok(self.handle())
    }
    async fn abort(
        &self,
        _handle: AgentExecutionHandle,
        _options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<bool> {
        Ok(false)
    }
    async fn running_sessions(
        &self,
        _options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Vec<AgentRunningSession>> {
        self.calls.borrow_mut().push("snapshot");
        let snapshot = self.snapshot.replace(Snapshot::Ready(Vec::new()));
        match snapshot {
            Snapshot::Ready(sessions) => Ok(sessions),
            Snapshot::Failed => Err("connection lost".into()),
            Snapshot::Pending(receiver) => Ok(receiver.await?),
        }
    }
}

#[async_trait(?Send)]
impl AgentProducers for TestAgent {
    fn scope(&self) -> ExecutorResult<AgentResourceScope> {
        Ok(self.scope.clone())
    }
    async fn bind(
        &self,
        _request: AgentProducerBindRequest,
        _options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        Ok(())
    }
    async fn close(
        &self,
        _binding: AgentProducerBinding,
        _options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        Ok(())
    }
    fn detach(&self, _binding: AgentProducerBinding) {}
    fn subscribe(
        &self,
        _listener: Rc<dyn Fn(AgentProducerNotification) -> ExecutorResult<()>>,
    ) -> Box<dyn Fn()> {
        Box::new(|| {})
    }
}

#[async_trait(?Send)]
impl AgentPermissions for TestAgent {
    async fn respond(
        &self,
        _request: AgentPermissionRespondRequest,
        _options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        Ok(())
    }
}

#[async_trait(?Send)]
impl AgentCatalog for TestAgent {
    async fn snapshot(
        &self,
        _request: AgentCatalogRequest,
    ) -> ExecutorResult<AgentCatalogSnapshot> {
        Ok(AgentCatalogSnapshot {
            models: Vec::new(),
            default_model: String::new(),
            requires_strict_model_discovery: false,
            generation: None,
        })
    }
}

#[async_trait(?Send)]
impl AgentSettings for TestAgent {
    fn describe(&self) -> &[AgentSettingDescriptor] {
        &self.settings_descriptors
    }
    fn defaults(&self) -> ExecutorResult<AgentSettingsEnvelope> {
        Ok(AgentSettingsEnvelope {
            owner_id: self.scope.integration_id.clone(),
            schema_version: 1,
            values: self.settings_values.clone(),
        })
    }
    fn parse(&self, input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope> {
        Ok(input)
    }
    async fn migrate(
        &self,
        mut input: AgentSettingsEnvelope,
    ) -> ExecutorResult<AgentSettingsEnvelope> {
        self.migrations.set(self.migrations.get() + 1);
        if self.migrations.get() == 2
            && let Some(values) = &self.second_migration_values
        {
            input.values = values.clone();
        }
        Ok(input)
    }
    fn apply_patch(
        &self,
        mut current: AgentSettingsEnvelope,
        _patch: IndexMap<String, Opaque>,
    ) -> ExecutorResult<AgentSettingsEnvelope> {
        if let Some(values) = &self.patch_values {
            current.values = values.clone();
        }
        Ok(current)
    }
}

#[async_trait(?Send)]
impl AgentLifecycle for TestAgent {
    async fn start(&self) -> ExecutorResult<()> {
        self.calls.borrow_mut().push("start");
        Ok(())
    }
    async fn stop(&self) -> ExecutorResult<()> {
        self.calls.borrow_mut().push("stop");
        Ok(())
    }
    async fn migrate_owned_storage(&self) -> ExecutorResult<()> {
        Ok(())
    }
}

#[async_trait(?Send)]
impl AgentMigration for TestAgent {
    async fn translate_legacy_model(
        &self,
        request: AgentTranslateLegacyModelRequest,
    ) -> ExecutorResult<String> {
        Ok(request.model)
    }
    async fn translate_legacy_native_session(
        &self,
        _request: AgentTranslateLegacyNativeSessionRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        Ok(None)
    }
    async fn translate_legacy_settings(
        &self,
        _request: AgentTranslateLegacySettingsRequest,
    ) -> ExecutorResult<Option<AgentSettingsEnvelope>> {
        Ok(None)
    }
}

#[async_trait(?Send)]
impl AgentSingleQuery for TestAgent {
    async fn run(&self, _request: AgentSingleQueryRequest) -> ExecutorResult<String> {
        Ok("Fixture response".into())
    }
    fn runs_tools_without_permission(&self) -> bool {
        false
    }
}

fn fixture(
    snapshot: Snapshot,
    configure: impl FnOnce(&mut TestAgent),
) -> (AgentIntegration, Rc<TestAgent>) {
    let mut agent = TestAgent {
        scope: AgentResourceScope {
            executor_id: "test".into(),
            instance_id: "fixture-instance".into(),
            integration_id: "other".into(),
        },
        calls: RefCell::new(Vec::new()),
        snapshot: RefCell::new(snapshot),
        migrations: Cell::new(0),
        settings_values: Opaque::parse("{}").unwrap(),
        settings_descriptors: Vec::new(),
        second_migration_values: None,
        patch_values: None,
    };
    configure(&mut agent);
    let agent = Rc::new(agent);
    let integration = AgentIntegration {
        descriptor: AgentDescriptor {
            id: "other".into(),
            label: "Other".into(),
            icon: None,
            supported_permission_modes: Vec::new(),
            supported_thinking_modes: Vec::new(),
            supports_images: false,
            supports_project_path_update: false,
            requires_native_path_for_project_path_update: false,
            supported_endpoint_protocols: Vec::new(),
            configuration: Vec::new(),
        },
        literal_execution: None,
        attachments: None,
        readiness: None,
        execution: agent.clone(),
        producers: agent.clone(),
        permissions: agent.clone(),
        catalog: agent.clone(),
        settings: agent.clone(),
        lifecycle: agent.clone(),
        migration: agent.clone(),
        auth: None,
        commands: None,
        compaction: None,
        forking: None,
        steering: None,
        endpoints: None,
        single_query: None,
        legacy_history_import: None,
        native_history_import: None,
        native_activity: None,
        native_sessions: None,
        configuration_validation: None,
        session_configuration: None,
        project_path_updates: None,
        usage_history: None,
        cli_updates: None,
    };
    (integration, agent)
}

fn options(integration: &AgentIntegration) -> AgentIntegrationConformanceOptions<'_> {
    AgentIntegrationConformanceOptions {
        integration_id: "other",
        api_version: AGENT_INTEGRATION_API_VERSION,
        integration,
    }
}

fn running(id: &str) -> AgentRunningSession {
    AgentRunningSession {
        agent_session_id: id.into(),
        status: None,
        started_at: None,
    }
}

#[test]
fn rejects_a_descriptor_and_class_id_mismatch() {
    let (integration, _) = fixture(Snapshot::Ready(Vec::new()), |_| {});
    let error = validate_agent_integration(AgentIntegrationConformanceOptions {
        integration_id: "fake",
        ..options(&integration)
    })
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Agent integration ID mismatch: fake != other"
    );
    let error = validate_agent_integration(AgentIntegrationConformanceOptions {
        api_version: 4,
        ..options(&integration)
    })
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Unsupported agent integration API version: 4"
    );
}

#[test]
fn rejects_duplicate_descriptor_values() {
    let (mut integration, _) = fixture(Snapshot::Ready(Vec::new()), |_| {});
    integration.descriptor.supported_permission_modes = vec![PermissionMode::Default; 2];
    let error = validate_agent_integration(options(&integration)).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Agent integration other declares duplicate permission modes"
    );
}

#[test]
fn rejects_incompatible_literal_execution_capabilities() {
    let (mut integration, agent) = fixture(Snapshot::Ready(Vec::new()), |_| {});
    integration.literal_execution = Some(AgentLiteralExecution {
        selection_label: "Fixture format".into(),
        input_format_by_model: Opaque::parse(r#"{"fixture-model":"plain"}"#).unwrap(),
    });
    validate_agent_integration(options(&integration)).unwrap();
    integration.single_query = Some(agent);
    let error = validate_agent_integration(options(&integration)).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Agent integration other has an invalid literal execution contract"
    );
}

#[test]
fn rejects_malformed_attachment_limits() {
    let (mut integration, _) = fixture(Snapshot::Ready(Vec::new()), |_| {});
    for value in [-1.0, 0.5, 9_007_199_254_740_992.0, f64::INFINITY] {
        integration.attachments = Some(AgentAttachments {
            file_mime_types: FileAttachmentMimeTypes::Any,
            inline_text_max_bytes: Some(Number(value)),
        });
        let error = validate_agent_integration(options(&integration)).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Agent integration other has an invalid attachments facet"
        );
    }
    integration.attachments = Some(AgentAttachments {
        file_mime_types: FileAttachmentMimeTypes::Text("all".into()),
        inline_text_max_bytes: None,
    });
    let error = validate_agent_integration(options(&integration)).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Agent integration other has an invalid attachments facet"
    );
}

#[test]
fn awaits_a_remote_snapshot_before_stopping_the_integration() {
    block_on(async {
        let (sender, receiver) = oneshot::channel();
        let (integration, agent) = fixture(Snapshot::Pending(receiver), |_| {});
        let mut checking = Box::pin(run_agent_integration_conformance(options(&integration)));
        assert!(poll!(checking.as_mut()).is_pending());
        assert_eq!(*agent.calls.borrow(), ["start", "start", "snapshot"]);
        sender.send(vec![running("fixture-session")]).unwrap();
        checking.await.unwrap();
        assert_eq!(
            *agent.calls.borrow(),
            ["start", "start", "snapshot", "stop", "stop"]
        );
    });
}

#[test]
fn stops_the_integration_when_a_remote_snapshot_fails() {
    let (integration, agent) = fixture(Snapshot::Failed, |_| {});
    let error = block_on(run_agent_integration_conformance(options(&integration))).unwrap_err();
    assert_eq!(error.to_string(), "connection lost");
    assert_eq!(
        *agent.calls.borrow(),
        ["start", "start", "snapshot", "stop", "stop"]
    );
}

#[test]
fn rejects_malformed_or_duplicate_running_session_snapshots() {
    for sessions in [
        vec![running("")],
        vec![running("duplicate"), running("duplicate")],
    ] {
        let (integration, _) = fixture(Snapshot::Ready(sessions), |_| {});
        let error = block_on(run_agent_integration_conformance(options(&integration))).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Agent integration other returned an invalid running session snapshot"
        );
    }
}

#[test]
fn rejects_an_empty_settings_patch_that_changes_the_envelope() {
    let (integration, _) = fixture(Snapshot::Ready(Vec::new()), |agent| {
        agent.patch_values = Some(Opaque::parse(r#"{"changed":true}"#).unwrap());
    });
    let error = block_on(run_agent_integration_conformance(options(&integration))).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Agent integration other changed settings for an empty patch"
    );
}

#[test]
fn rejects_a_second_migration_that_changes_its_input() {
    let (integration, _) = fixture(Snapshot::Ready(Vec::new()), |agent| {
        agent.second_migration_values = Some(Opaque::parse(r#"{"changed":true}"#).unwrap());
    });
    let error = block_on(run_agent_integration_conformance(options(&integration))).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Agent integration other settings migration is not idempotent"
    );
}

#[test]
fn preserves_signed_zero_in_the_strict_settings_comparison() {
    let (integration, _) = fixture(Snapshot::Ready(Vec::new()), |agent| {
        agent.settings_descriptors.push(AgentSettingDescriptor {
            key: "counter".into(),
            label: "Counter".into(),
            label_key: None,
            kind: AgentSettingKind::Number {
                min: Number(-1.0),
                max: Number(1.0),
                step: Number(1.0),
            },
        });
        agent.settings_values = Opaque::parse(r#"{"counter":-0}"#).unwrap();
        agent.patch_values = Some(Opaque::parse(r#"{"counter":0}"#).unwrap());
    });
    let error = block_on(run_agent_integration_conformance(options(&integration))).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Agent integration other changed settings for an empty patch"
    );
}
