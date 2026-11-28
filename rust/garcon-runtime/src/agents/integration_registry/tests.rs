use std::cell::Cell;
use std::path::Path;

use async_trait::async_trait;
use futures::channel::oneshot;
use garcon_base::errors::{ErrorInput, diagnostic_error_code};
use garcon_contract::agent_integration::{
    AgentConfigurationDescriptor, AgentConfigurationSource, AgentDescriptor,
    AgentSettingDescriptor, AgentSettingsEnvelope,
};
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::execution::AgentRunningSession;
use garcon_interface::execution_v5::{
    AgentExecutionHandle, AgentExecutionV5, AgentResumeRequestV5, AgentStartRequestV5,
};
use garcon_interface::host::AgentHost;
use garcon_interface::producer::{
    AgentPermissionRespondRequest, AgentPermissions, AgentProducerBindRequest,
    AgentProducerNotification, AgentProducers,
};
use garcon_interface::resources::{AgentProducerBinding, AgentResourceScope, ExecutorCallOptions};
use garcon_interface::services::*;
use garcon_interface::transcript::AgentNativeSessionRef;
use garcon_js::json::Opaque;

use super::*;
use crate::agents::integration_host::IntegrationHostFactoryOptions;

#[derive(Default)]
struct Observation {
    calls: RefCell<Vec<(String, &'static str)>>,
    constructed: Cell<usize>,
}

struct Fixture {
    host: AgentHost,
    observation: Rc<Observation>,
    fail_start: Option<AgentIntegrationError>,
    fail_stop: bool,
    startup: RefCell<Option<oneshot::Receiver<()>>>,
}

impl Fixture {
    fn call(&self, action: &'static str) {
        self.observation
            .calls
            .borrow_mut()
            .push((self.host.agent_id.clone(), action));
    }
}

#[async_trait(?Send)]
impl AgentLifecycle for Fixture {
    async fn migrate_owned_storage(&self) -> ExecutorResult<()> {
        self.call("migrate");
        Ok(())
    }
    async fn start(&self) -> ExecutorResult<()> {
        self.call("start");
        let startup = self.startup.take();
        if let Some(startup) = startup {
            startup.await?;
        }
        if let Some(error) = &self.fail_start {
            return Err(error.clone().into());
        }
        Ok(())
    }
    async fn stop(&self) -> ExecutorResult<()> {
        self.call("stop");
        if self.fail_stop {
            return Err(format!("stop {}", self.host.agent_id).into());
        }
        Ok(())
    }
}

#[async_trait(?Send)]
impl AgentSettings for Fixture {
    fn describe(&self) -> &[AgentSettingDescriptor] {
        &[]
    }
    fn defaults(&self) -> ExecutorResult<AgentSettingsEnvelope> {
        Ok(AgentSettingsEnvelope {
            owner_id: self.host.agent_id.clone(),
            schema_version: 1,
            values: serde_json::json!({}).into(),
        })
    }
    fn parse(&self, input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope> {
        Ok(input)
    }
    async fn migrate(&self, input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope> {
        Ok(input)
    }
    fn apply_patch(
        &self,
        current: AgentSettingsEnvelope,
        _: IndexMap<String, Opaque>,
    ) -> ExecutorResult<AgentSettingsEnvelope> {
        Ok(current)
    }
}

#[async_trait(?Send)]
impl AgentMigration for Fixture {
    async fn translate_legacy_model(
        &self,
        request: AgentTranslateLegacyModelRequest,
    ) -> ExecutorResult<String> {
        Ok(request.model)
    }
    async fn translate_legacy_native_session(
        &self,
        _: AgentTranslateLegacyNativeSessionRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        Ok(None)
    }
    async fn translate_legacy_settings(
        &self,
        _: AgentTranslateLegacySettingsRequest,
    ) -> ExecutorResult<Option<AgentSettingsEnvelope>> {
        Ok(None)
    }
}

#[async_trait(?Send)]
impl AgentProducers for Fixture {
    fn scope(&self) -> &AgentResourceScope {
        &self.host.scope
    }
    async fn bind(
        &self,
        _: AgentProducerBindRequest,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        Ok(())
    }
    async fn close(
        &self,
        _: AgentProducerBinding,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        Ok(())
    }
    fn detach(&self, _: AgentProducerBinding) {}
    fn subscribe(
        &self,
        _: Rc<dyn Fn(AgentProducerNotification) -> ExecutorResult<()>>,
    ) -> Box<dyn Fn()> {
        Box::new(|| {})
    }
}

#[async_trait(?Send)]
impl AgentPermissions for Fixture {
    async fn respond(
        &self,
        _: AgentPermissionRespondRequest,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        Ok(())
    }
}

#[async_trait(?Send)]
impl AgentCatalog for Fixture {
    async fn snapshot(&self, _: AgentCatalogRequest) -> ExecutorResult<AgentCatalogSnapshot> {
        Ok(AgentCatalogSnapshot {
            models: Vec::new(),
            default_model: String::new(),
            requires_strict_model_discovery: false,
            generation: None,
        })
    }
}

#[async_trait(?Send)]
impl AgentExecutionV5 for Fixture {
    async fn start(
        &self,
        _: AgentStartRequestV5,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        Err("unexpected start".into())
    }
    async fn resume(
        &self,
        _: AgentResumeRequestV5,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        Err("unexpected resume".into())
    }
    async fn abort(
        &self,
        _: AgentExecutionHandle,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<bool> {
        Ok(false)
    }
    async fn running_sessions(
        &self,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Vec<AgentRunningSession>> {
        Ok(Vec::new())
    }
}

struct FixtureClass<'a> {
    id: &'a str,
    version: u64,
    observation: Rc<Observation>,
    fail_start: Option<AgentIntegrationError>,
    fail_stop: bool,
    startup: RefCell<Option<oneshot::Receiver<()>>>,
}

impl<'a> FixtureClass<'a> {
    fn new(id: &'a str, observation: Rc<Observation>) -> Self {
        Self {
            id,
            version: AGENT_INTEGRATION_API_VERSION,
            observation,
            fail_start: None,
            fail_stop: false,
            startup: RefCell::default(),
        }
    }
}

impl AgentIntegrationClass for FixtureClass<'_> {
    fn integration_id(&self) -> &str {
        self.id
    }
    fn api_version(&self) -> u64 {
        self.version
    }
    fn create(&self, host: AgentHost) -> AgentIntegration {
        self.observation
            .constructed
            .set(self.observation.constructed.get() + 1);
        let fixture = Rc::new(Fixture {
            host,
            observation: self.observation.clone(),
            fail_start: self.fail_start.clone(),
            fail_stop: self.fail_stop,
            startup: self.startup.take().into(),
        });
        AgentIntegration {
            descriptor: AgentDescriptor {
                id: self.id.into(),
                label: self.id.into(),
                icon: None,
                supported_permission_modes: Vec::new(),
                supported_thinking_modes: Vec::new(),
                supports_images: false,
                supports_project_path_update: false,
                requires_native_path_for_project_path_update: false,
                supported_endpoint_protocols: Vec::new(),
                configuration: vec![AgentConfigurationDescriptor {
                    key: format!("{}_BIN", self.id.to_uppercase()),
                    source: AgentConfigurationSource::Environment,
                    description: "Binary".into(),
                }],
            },
            literal_execution: None,
            attachments: None,
            execution: fixture.clone(),
            producers: fixture.clone(),
            permissions: fixture.clone(),
            catalog: fixture.clone(),
            settings: fixture.clone(),
            lifecycle: fixture.clone(),
            migration: fixture,
            readiness: None,
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
        }
    }
}

fn factory(workspace: &Path) -> IntegrationHostFactory {
    IntegrationHostFactory::new(IntegrationHostFactoryOptions {
        workspace_dir: workspace.to_str().unwrap().into(),
        executor_id: None,
        instance_id: None,
        resolve_credential: Rc::new(|_| Box::pin(async { Ok(None) })),
        read_environment: Some(Rc::new(|name| {
            (name == "ALPHA_BIN").then(|| "alpha-bin".into())
        })),
        logger_factory: None,
    })
}

#[test]
fn validates_before_constructing_and_binds_a_single_instance() {
    let workspace = tempfile::tempdir().unwrap();
    let hosts = factory(workspace.path());
    let observation = Rc::new(Observation::default());
    let alpha = FixtureClass::new("alpha", observation.clone());
    let duplicate = FixtureClass::new("alpha", observation.clone());
    let error = IntegrationRegistry::from_classes(&[&alpha, &duplicate], &hosts)
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "Duplicate agent integration ID: alpha");
    assert_eq!(observation.constructed.get(), 1);
    assert_eq!(
        hosts
            .for_agent("alpha")
            .unwrap()
            .environment
            .get("ALPHA_BIN")
            .unwrap()
            .as_deref(),
        Some("alpha-bin")
    );
    let bad = FixtureClass {
        version: 1,
        ..FixtureClass::new("bad", observation.clone())
    };
    let error = IntegrationRegistry::from_classes(&[&bad], &hosts)
        .err()
        .unwrap();
    assert_eq!(
        error.to_string(),
        "Unsupported agent integration API version for bad: 1"
    );
    assert_eq!(observation.constructed.get(), 1);
    let workspace = tempfile::tempdir().unwrap();
    let registry =
        IntegrationRegistry::from_classes(&[&alpha], &factory(workspace.path())).unwrap();
    let first = registry.require("alpha").unwrap();
    assert!(Rc::ptr_eq(&first, &registry.require("alpha").unwrap()));
    assert!(
        registry
            .require("beta")
            .err()
            .unwrap()
            .is::<UnknownAgentIntegration>()
    );
}

#[tokio::test]
async fn rolls_back_only_started_integrations_in_reverse_order_and_keeps_both_failures() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let workspace = tempfile::tempdir().unwrap();
            let observation = Rc::new(Observation::default());
            let alpha = FixtureClass {
                fail_stop: true,
                ..FixtureClass::new("alpha", observation.clone())
            };
            let beta = FixtureClass::new("beta", observation.clone());
            let gamma = FixtureClass {
                fail_start: Some(AgentIntegrationError::new(
                    AgentIntegrationErrorCode::PROVIDER_FAILURE,
                    "boom",
                    false,
                    None,
                )),
                ..FixtureClass::new("gamma", observation.clone())
            };
            let registry = IntegrationRegistry::from_classes(
                &[&alpha, &beta, &gamma],
                &factory(workspace.path()),
            )
            .unwrap();
            let error = registry.start().await.unwrap_err();
            assert_eq!(
                error.to_string(),
                "Agent integration startup failed and lifecycle rollback was incomplete"
            );
            assert_eq!(
                diagnostic_error_code(ErrorInput::Error(error.as_ref())),
                "AggregateError"
            );
            let metadata = error_metadata(error.as_ref());
            assert_eq!(metadata.name, "AggregateError");
            assert_eq!(metadata.code, None);
            let aggregate = error
                .source()
                .unwrap()
                .downcast_ref::<IntegrationLifecycleErrors>()
                .unwrap();
            assert_eq!(
                aggregate
                    .errors
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>(),
                ["boom", "stop alpha"]
            );
            registry.stop().await.unwrap();
            assert_eq!(
                observation
                    .calls
                    .borrow()
                    .iter()
                    .map(|(id, action)| (id.as_str(), *action))
                    .collect::<Vec<_>>(),
                [
                    ("alpha", "migrate"),
                    ("alpha", "start"),
                    ("beta", "migrate"),
                    ("beta", "start"),
                    ("gamma", "migrate"),
                    ("gamma", "start"),
                    ("beta", "stop"),
                    ("alpha", "stop")
                ]
            );
        })
        .await;
}

#[tokio::test]
async fn concurrent_waiters_keep_the_original_structured_lifecycle_failure() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let workspace = tempfile::tempdir().unwrap();
            let observation = Rc::new(Observation::default());
            let alpha = FixtureClass {
                fail_start: Some(AgentIntegrationError::new(
                    AgentIntegrationErrorCode::INVALID_SETTINGS,
                    "synthetic lifecycle failure",
                    false,
                    None,
                )),
                ..FixtureClass::new("alpha", observation.clone())
            };
            let registry =
                IntegrationRegistry::from_classes(&[&alpha], &factory(workspace.path())).unwrap();
            let (one, two) = tokio::join!(registry.start(), registry.start());
            let one = one.unwrap_err();
            let two = two.unwrap_err();
            for failure in [&one, &two] {
                assert_eq!(failure.to_string(), "synthetic lifecycle failure");
                assert_eq!(
                    diagnostic_error_code(ErrorInput::Error(failure.as_ref())),
                    "INVALID_SETTINGS"
                );
                assert_eq!(
                    error_metadata(failure.as_ref()).name,
                    "AgentIntegrationError"
                );
                assert!(failure.source().unwrap().is::<AgentIntegrationError>());
            }
            assert!(std::ptr::eq(one.source().unwrap(), two.source().unwrap()));
            assert_eq!(observation.calls.borrow().len(), 2);
        })
        .await;
}

#[tokio::test]
async fn shutdown_aggregation_keeps_the_reverse_order_and_name_after_erasure() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let workspace = tempfile::tempdir().unwrap();
            let observation = Rc::new(Observation::default());
            let alpha = FixtureClass {
                fail_stop: true,
                ..FixtureClass::new("alpha", observation.clone())
            };
            let beta = FixtureClass {
                fail_stop: true,
                ..FixtureClass::new("beta", observation.clone())
            };
            let registry =
                IntegrationRegistry::from_classes(&[&alpha, &beta], &factory(workspace.path()))
                    .unwrap();
            registry.start().await.unwrap();
            let failure = registry.stop().await.unwrap_err();
            assert_eq!(failure.to_string(), "Agent integration shutdown failed");
            assert_eq!(
                diagnostic_error_code(ErrorInput::Error(failure.as_ref())),
                "AggregateError"
            );
            assert_eq!(error_metadata(failure.as_ref()).name, "AggregateError");
            let aggregate = failure
                .source()
                .unwrap()
                .downcast_ref::<IntegrationLifecycleErrors>()
                .unwrap();
            assert_eq!(
                aggregate
                    .errors
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>(),
                ["stop beta", "stop alpha"]
            );
        })
        .await;
}

#[tokio::test]
async fn concurrent_start_and_stop_share_the_process_owned_lifecycle() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let workspace = tempfile::tempdir().unwrap();
            let observation = Rc::new(Observation::default());
            let (release, startup) = oneshot::channel();
            let alpha = FixtureClass {
                startup: Some(startup).into(),
                ..FixtureClass::new("alpha", observation.clone())
            };
            let registry =
                IntegrationRegistry::from_classes(&[&alpha], &factory(workspace.path())).unwrap();
            let mut original = Box::pin(registry.start());
            assert!(futures::poll!(&mut original).is_pending());
            drop(original);
            let mut wait_for_start = Box::pin(registry.start());
            assert!(futures::poll!(&mut wait_for_start).is_pending());
            let mut first_stop = Box::pin(registry.stop());
            assert!(futures::poll!(&mut first_stop).is_pending());
            release.send(()).unwrap();
            let (started, stopped, stopped_again) =
                tokio::join!(wait_for_start, first_stop, registry.stop());
            started.unwrap();
            stopped.unwrap();
            stopped_again.unwrap();
            assert_eq!(
                observation
                    .calls
                    .borrow()
                    .iter()
                    .map(|(_, action)| *action)
                    .collect::<Vec<_>>(),
                ["migrate", "start", "stop"]
            );
        })
        .await;
}
