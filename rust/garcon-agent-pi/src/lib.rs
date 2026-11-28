//! Ports `server-agents/pi/src/index.ts`.

pub mod config;
pub mod execution;
pub mod history_loader;
pub mod lazy_runtime;
pub mod message_converter;
pub mod native_activity;
pub mod pi_auth;
pub mod pi_cli;
pub mod pi_models;
pub mod pi_process_lifecycle;
pub mod pi_rpc_client;
pub mod pi_rpc_protocol;
pub mod pi_rpc_runtime;
mod pi_rpc_session_state;
pub mod pi_session_paths;
pub mod runtime_types;
pub mod session_projection;
pub mod tool_use_converter;

use std::rc::Rc;

use async_trait::async_trait;
use futures::FutureExt;
use garcon_agents_common::{
    catalog::model_catalog::ModelCatalog,
    chats::artificial_native_path::{
        ARTIFICIAL_NATIVE_PATH_PREFIX, create_artificial_native_path,
        get_artificial_agent_session_id,
    },
    errors::has_node_error_code,
    execution::{
        control_adapters::create_agent_steering, producer_adapter::create_agent_producer_adapter,
        project_path_adapter::create_agent_project_path_updates,
    },
    lifecycle::integration_lifecycle::{IntegrationLifecycle, IntegrationLifecycleOptions},
    logging::scoped_agent_logger::create_scoped_agent_logger,
    migration::version_1_record_migration::Version1RecordMigration,
    native_session::{
        evidence_source::{AgentNativeEvidenceSnapshot, AgentNativeEvidenceSource},
        native_history_import::{create_history_import, create_native_history_import},
        path_native_session::{PathNativeSessionCodec, PathNativeSessionValue},
    },
    settings::versioned_settings::VersionedSettings,
    shared::single_query_control::{run_isolated_single_query, single_query_runtime_options},
};
use garcon_base::errors::ErrorInput;
use garcon_contract::{
    agent_execution::AgentAuthStatus,
    agent_integration::{
        AgentConfigurationDescriptor, AgentConfigurationSource, AgentDescriptor,
        AgentSettingsEnvelope,
    },
    agents::AgentModelOption,
    chat_modes::{PERMISSION_MODE_VALUES, PermissionMode, THINKING_MODE_VALUES},
    models::PI_MODELS,
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    host::AgentHost,
    integration::{AGENT_INTEGRATION_API_VERSION, AgentIntegration, AgentIntegrationClass},
    native_history::{
        AgentHistoryImportRequest, AgentNativeSessionAccess, AgentNativeSessionReleaseRequest,
    },
    resources::ExecutorResult,
    services::{AgentAuth, AgentAuthLoginCapabilities, AgentSingleQuery, AgentSingleQueryRequest},
    transcript::{AgentChatReference, AgentNativeSessionRef, AgentTranscriptSourceLocation},
};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    config::{PiConfig, create_pi_config},
    execution::PiExecution,
    history_loader::load_pi_chat_messages,
    lazy_runtime::{LazyPiRuntime, PiRuntime},
    native_activity::create_pi_native_activity_probe,
    pi_auth::get_pi_auth_status,
    pi_cli::run_single_query,
    pi_models::{PiModelCatalogService, check_abort},
    pi_rpc_runtime::PiRpcRuntime,
    pi_session_paths::find_pi_session_file_by_session_id,
};

const ID: &str = "pi";

pub struct PiAgentIntegration;

impl AgentIntegrationClass for PiAgentIntegration {
    fn integration_id(&self) -> &str {
        ID
    }
    fn api_version(&self) -> u64 {
        AGENT_INTEGRATION_API_VERSION
    }

    fn create(&self, host: AgentHost) -> AgentIntegration {
        let config = Rc::new(create_pi_config(host.environment));
        let logger = create_scoped_agent_logger(host.logger.clone(), ID);
        let models = Rc::new(PiModelCatalogService::new(config.clone()));
        let native_sessions = Rc::new(PathNativeSessionCodec::new(ID));
        let runtime = Rc::new(LazyPiRuntime::new(Rc::new({
            let config = config.clone();
            let models = models.clone();
            move || {
                let config = config.clone();
                let logger = logger.clone();
                let models = models.clone();
                async move {
                    Ok(Rc::new(PiRpcRuntime::new(config, logger, models)) as Rc<dyn PiRuntime>)
                }
                .boxed_local()
            }
        })));
        let settings = Rc::new(VersionedSettings::new(
            AgentSettingsEnvelope {
                owner_id: ID.to_owned(),
                schema_version: 1,
                values: json!({}).into(),
            },
            Vec::new(),
            None,
        ));
        let execution = Rc::new(PiExecution {
            runtime: runtime.clone(),
            native_sessions: native_sessions.clone(),
        });
        let new_id: Rc<dyn Fn() -> String> = Rc::new(|| uuid::Uuid::new_v4().to_string());
        let producer = create_agent_producer_adapter(
            execution.clone(),
            host.logger.clone(),
            host.scope.clone(),
            new_id.clone(),
        );
        let project_path_updates = create_agent_project_path_updates(
            host.scope,
            Rc::new(|request| {
                async move {
                    check_abort(&request.signal)?;
                    Ok(None)
                }
                .boxed_local()
            }),
            new_id.clone(),
        );
        let evidence = Rc::new(PiNativeEvidence {
            config: config.clone(),
            sessions: native_sessions.clone(),
            runtime: runtime.clone(),
        });
        let legacy_history = create_history_import({
            let evidence = evidence.clone();
            async move |request| evidence.load_legacy(request).await
        });
        let native_history = create_native_history_import({
            let evidence = evidence.clone();
            async move |request| evidence.load(request).await
        });
        let catalog = ModelCatalog {
            logger: host.logger,
            default_model: PI_MODELS.default.to_owned(),
            fallback_models: PI_MODELS
                .options
                .iter()
                .map(|model| AgentModelOption {
                    value: model.value.to_owned(),
                    label: model.label.to_owned(),
                    supports_images: model.supports_images,
                    thinking_modes: None,
                    is_local: None,
                    api_provider_id: None,
                    endpoint_id: None,
                    raw_model: None,
                    protocol: None,
                })
                .collect(),
            requires_strict_model_discovery: true,
            generation: None,
            discover: Some(Box::new({
                let models = models.clone();
                move |request| {
                    let models = models.clone();
                    async move {
                        if request.strict {
                            models.get_models_strict(Some(&request.signal)).await
                        } else {
                            models.get_models(Some(&request.signal)).await
                        }
                    }
                    .boxed_local()
                }
            })),
        };
        let lifecycle = IntegrationLifecycle::new(IntegrationLifecycleOptions {
            start: Some(Box::new({
                let models = models.clone();
                let runtime = runtime.clone();
                move || {
                    models.start();
                    runtime.start_purge_timer();
                    async { Ok(()) }.boxed_local()
                }
            })),
            stop: Some(Box::new({
                let models = models.clone();
                move || {
                    let models = models.clone();
                    let runtime = runtime.clone();
                    async move { tokio::join!(models.stop(), runtime.shutdown()).1 }.boxed_local()
                }
            })),
            migrate_owned_storage: None,
        });
        let steering = create_agent_steering(producer.clone(), execution, new_id);
        let migration = Version1RecordMigration {
            settings: settings.clone(),
            native_sessions: Some(PathNativeSessionCodec::new(ID)),
            translate_model: None,
        };
        // INFALLIBLE: Pi uses the fixed positive default tail size.
        let native_activity = create_pi_native_activity_probe(native_sessions)
            .expect("default Pi native activity probe");
        AgentIntegration {
            descriptor: descriptor(),
            literal_execution: None,
            attachments: None,
            execution: producer.clone(),
            producers: producer.clone(),
            permissions: producer,
            catalog: Rc::new(catalog),
            settings,
            lifecycle: Rc::new(lifecycle),
            migration: Rc::new(migration),
            readiness: None,
            auth: Some(Rc::new(PiAuth { models })),
            commands: None,
            compaction: None,
            forking: None,
            steering: Some(steering),
            endpoints: None,
            single_query: Some(Rc::new(PiSingleQuery { config })),
            legacy_history_import: Some(Rc::new(legacy_history)),
            native_history_import: Some(Rc::new(native_history)),
            native_activity: Some(Rc::new(native_activity)),
            native_sessions: Some(evidence),
            configuration_validation: None,
            session_configuration: None,
            project_path_updates: Some(project_path_updates),
            usage_history: None,
            cli_updates: None,
        }
    }
}

fn descriptor() -> AgentDescriptor {
    AgentDescriptor {
        id: ID.to_owned(),
        label: "Pi".to_owned(),
        icon: None,
        supported_permission_modes: PERMISSION_MODE_VALUES
            .iter()
            .copied()
            .filter(|mode| *mode != PermissionMode::Plan)
            .collect(),
        supported_thinking_modes: THINKING_MODE_VALUES.to_vec(),
        supports_images: false,
        supports_project_path_update: true,
        requires_native_path_for_project_path_update: true,
        supported_endpoint_protocols: Vec::new(),
        configuration: [
            ("GARCON_PI_BINARY", "Garcon Pi CLI binary."),
            ("PI_BINARY", "Pi CLI binary."),
            ("PI_CODING_AGENT_DIR", "Pi agent directory."),
            ("PI_CODING_AGENT_SESSION_DIR", "Pi session directory."),
            ("HOME", "User home directory."),
            ("NODE_ENV", "Runtime environment."),
        ]
        .into_iter()
        .map(|(key, description)| AgentConfigurationDescriptor {
            key: key.to_owned(),
            source: AgentConfigurationSource::Environment,
            description: description.to_owned(),
        })
        .collect(),
    }
}

struct PiAuth {
    models: Rc<PiModelCatalogService>,
}

#[async_trait(?Send)]
impl AgentAuth for PiAuth {
    async fn status(&self, signal: CancellationToken) -> ExecutorResult<AgentAuthStatus> {
        check_abort(&signal)?;
        get_pi_auth_status(&self.models, Some(&signal)).await
    }

    fn login_capabilities(&self) -> AgentAuthLoginCapabilities {
        AgentAuthLoginCapabilities::default()
    }
}

struct PiSingleQuery {
    config: Rc<PiConfig>,
}

#[async_trait(?Send)]
impl AgentSingleQuery for PiSingleQuery {
    async fn run(&self, request: AgentSingleQueryRequest) -> ExecutorResult<String> {
        let input = &request;
        run_isolated_single_query(input, |directory| async move {
            let options = single_query_runtime_options(input);
            let mut values = Map::new();
            values.insert("model".to_owned(), json!(input.model));
            values.extend(
                options
                    .values
                    .into_iter()
                    .map(|(key, value)| (key, value.into_value())),
            );
            values.insert("projectPath".to_owned(), json!(directory));
            run_single_query(
                &input.prompt,
                &Value::Object(values),
                Some(options.signal),
                &self.config,
            )
            .await
        })
        .await
    }

    fn runs_tools_without_permission(&self) -> bool {
        false
    }
}

struct PiNativeEvidence {
    config: Rc<PiConfig>,
    sessions: Rc<PathNativeSessionCodec>,
    runtime: Rc<LazyPiRuntime>,
}

struct PiReference<'a> {
    project_path: &'a str,
    native_path: Option<String>,
    agent_session_id: Option<String>,
}

impl PiNativeEvidence {
    fn reference<'a>(&self, chat: &'a AgentChatReference) -> ExecutorResult<PiReference<'a>> {
        let native = self.sessions.decode(chat.native_session.as_ref())?;
        let agent_session_id = chat
            .agent_session_id
            .clone()
            .or(native.agent_session_id)
            .or_else(|| get_artificial_agent_session_id(&json!(native.path), [ID]));
        Ok(PiReference {
            project_path: &chat.project_path,
            native_path: native.path,
            agent_session_id,
        })
    }

    async fn resolve_history_path(
        &self,
        reference: &PiReference<'_>,
    ) -> ExecutorResult<Option<String>> {
        if let Some(path) = &reference.native_path
            && !path.is_empty()
            && !path.starts_with(ARTIFICIAL_NATIVE_PATH_PREFIX)
        {
            return Ok(Some(path.clone()));
        }
        let Some(id) = reference
            .agent_session_id
            .as_deref()
            .filter(|id| !id.is_empty())
        else {
            return Ok(None);
        };
        find_pi_session_file_by_session_id(id, reference.project_path, &self.config).await
    }

    async fn load_legacy(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<AgentNativeEvidenceSnapshot> {
        check_abort(&request.signal)?;
        let loaded = async {
            let path = self
                .resolve_history_path(&self.reference(&request.chat)?)
                .await?;
            let messages = match path {
                Some(path) => load_pi_chat_messages(&path).await?,
                None => Vec::new(),
            };
            Ok::<_, Box<dyn std::error::Error>>(AgentNativeEvidenceSnapshot { messages })
        }
        .await;
        match loaded {
            Err(error) if has_node_error_code(ErrorInput::Error(error.as_ref()), "ENOENT") => {
                Ok(AgentNativeEvidenceSnapshot::default())
            }
            loaded => loaded,
        }
    }
}

#[async_trait(?Send)]
impl AgentNativeEvidenceSource for PiNativeEvidence {
    async fn load(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<AgentNativeEvidenceSnapshot> {
        check_abort(&request.signal)?;
        let path = self
            .resolve_history_path(&self.reference(&request.chat)?)
            .await?;
        check_abort(&request.signal)?;
        let Some(path) = path else {
            return Err(AgentIntegrationError::new(
                AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
                "Pi native transcript has no selected session",
                false,
                None,
            )
            .into());
        };
        Ok(AgentNativeEvidenceSnapshot {
            messages: load_pi_chat_messages(&path).await?,
        })
    }
}

#[async_trait(?Send)]
impl AgentNativeSessionAccess for PiNativeEvidence {
    async fn resolve_native_session(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        check_abort(&request.signal)?;
        let reference = self.reference(&request.chat)?;
        let path = self.resolve_history_path(&reference).await?.or_else(|| {
            create_artificial_native_path(Some(ID), reference.agent_session_id.as_deref())
        });
        Ok(self.sessions.encode(PathNativeSessionValue {
            path,
            agent_session_id: reference.agent_session_id,
            model_endpoint_id: None,
        }))
    }

    async fn describe_source(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentTranscriptSourceLocation>> {
        check_abort(&request.signal)?;
        let reference = self.reference(&request.chat)?;
        if let Some(value) = self.resolve_history_path(&reference).await? {
            return Ok(Some(AgentTranscriptSourceLocation::FilesystemPath {
                value,
            }));
        }
        Ok(reference
            .agent_session_id
            .filter(|value| !value.is_empty())
            .map(|value| AgentTranscriptSourceLocation::ProviderReference { value }))
    }

    async fn release(&self, request: AgentNativeSessionReleaseRequest) -> ExecutorResult<()> {
        check_abort(&request.request.signal)?;
        let chat = request.request.chat;
        let reference = self.reference(&chat)?;
        self.runtime
            .release_session(&chat.chat_id, reference.agent_session_id.as_deref())
            .await
    }
}
