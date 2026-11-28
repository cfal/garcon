//! Ports `server-agents/opencode/src/index.ts`.

use std::rc::Rc;

use async_trait::async_trait;
use futures::FutureExt;
use garcon_agents_common::{
    catalog::model_catalog::ModelCatalog,
    execution::{
        control_adapters::{RuntimeSteering, create_agent_steering},
        producer_adapter::{AgentProducerAdapter, create_agent_producer_adapter},
        project_path_adapter::create_agent_project_path_updates,
        runtime_events::{RuntimeSteerRequest, RuntimeSteerTarget},
    },
    lifecycle::integration_lifecycle::{IntegrationLifecycle, IntegrationLifecycleOptions},
    logging::scoped_agent_logger::create_scoped_agent_logger,
    migration::version_1_record_migration::Version1RecordMigration,
    native_session::{
        evidence_source::{
            AgentNativeEvidenceRequest, AgentNativeEvidenceSnapshot, AgentNativeEvidenceSource,
        },
        native_history_import::{create_history_import, create_native_history_import},
        path_native_session::PathNativeSessionCodec,
    },
    settings::versioned_settings::VersionedSettings,
};
use garcon_contract::{
    agent_execution::AgentAuthStatus,
    agent_integration::{
        AgentConfigurationDescriptor, AgentConfigurationSource, AgentDescriptor,
        AgentSettingsEnvelope,
    },
    agents::AgentModelOption,
    attachments::{
        DOCUMENT_FILE_ATTACHMENT_MIME_TYPES, FileAttachmentMimeTypes,
        VIDEO_FILE_ATTACHMENT_MIME_TYPES,
    },
    chat_modes::{PERMISSION_MODE_VALUES, PermissionMode, THINKING_MODE_VALUES, ThinkingMode},
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    execution_v5::{AgentExecutionHandle, AgentResumeRequestV5},
    host::{AgentHost, AgentLogger},
    integration::{AGENT_INTEGRATION_API_VERSION, AgentIntegration, AgentIntegrationClass},
    native_history::{
        AgentHistoryImportRequest, AgentNativeSessionAccess, AgentNativeSessionReleaseRequest,
    },
    resources::{ExecutorCallOptions, ExecutorResult},
    services::{
        AgentAttachments, AgentAuth, AgentAuthLoginCapabilities, AgentCompaction,
        AgentGenerationModel, AgentSingleQuery, AgentSingleQueryRequest, AgentSteerResult,
    },
    transcript::{AgentNativeSessionRef, AgentTranscriptSourceLocation},
};
use garcon_js::{Number, SystemClock};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::{
    agents::opencode::{
        execution::{OpenCodeExecution, encode_session, resolve_session_id},
        forking::OpenCodeNativeForking,
        history_loader::{
            HistoryLoadOptions, OpenCodeTranscriptNotFoundError,
            load_required_open_code_chat_messages,
        },
        native_activity::OpenCodeNativeActivity,
        opencode::OpenCodeRuntime,
        opencode_auth::get_open_code_auth_status,
        project_path::{OpenCodeProjectPathRuntime, create_open_code_project_path_updates},
        runtime_options::OpenCodeRuntimeOptions,
    },
    config::OpenCodeConfig,
    js::AbortSignal,
};

pub struct OpenCodeAgentIntegration;

impl AgentIntegrationClass for OpenCodeAgentIntegration {
    fn integration_id(&self) -> &str {
        "opencode"
    }
    fn api_version(&self) -> u64 {
        AGENT_INTEGRATION_API_VERSION
    }
    fn create(&self, host: AgentHost) -> AgentIntegration {
        create_integration(host)
    }
}

fn descriptor() -> AgentDescriptor {
    AgentDescriptor {
        id: "opencode".to_owned(),
        label: "OpenCode".to_owned(),
        icon: None,
        supported_permission_modes: PERMISSION_MODE_VALUES
            .iter()
            .copied()
            .filter(|mode| *mode != PermissionMode::Plan)
            .collect(),
        supported_thinking_modes: THINKING_MODE_VALUES
            .iter()
            .copied()
            .filter(|mode| *mode != ThinkingMode::Ultra)
            .collect(),
        supports_images: true,
        supports_project_path_update: true,
        requires_native_path_for_project_path_update: false,
        supported_endpoint_protocols: Vec::new(),
        configuration: vec![AgentConfigurationDescriptor {
            key: "NODE_ENV".to_owned(),
            source: AgentConfigurationSource::Environment,
            description: "Runtime environment.".to_owned(),
        }],
    }
}

fn create_integration(host: AgentHost) -> AgentIntegration {
    let logger = create_scoped_agent_logger(host.logger.clone(), "opencode");
    let runtime = OpenCodeRuntime::new(OpenCodeRuntimeOptions {
        config: Some(OpenCodeConfig::from_environment(host.environment)),
        logger: Some(logger.clone()),
        ..Default::default()
    });
    let settings = Rc::new(VersionedSettings::new(
        AgentSettingsEnvelope {
            owner_id: "opencode".to_owned(),
            schema_version: 1,
            values: json!({}).into(),
        },
        Vec::new(),
        None,
    ));
    let native_sessions = Rc::new(PathNativeSessionCodec::new("opencode"));
    let execution = Rc::new(OpenCodeExecution {
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
    let native = Rc::new(OpenCodeNativeEvidence {
        runtime: runtime.clone(),
        native_sessions: native_sessions.clone(),
        logger: logger.clone(),
    });
    let project_path_updates = create_agent_project_path_updates(
        host.scope,
        create_open_code_project_path_updates(execution.clone(), {
            let native_sessions = native_sessions.clone();
            move |chat| resolve_session_id(&native_sessions, chat)
        }),
        new_id.clone(),
    );
    let catalog = ModelCatalog {
        logger: host.logger,
        default_model: String::new(),
        fallback_models: Vec::new(),
        requires_strict_model_discovery: false,
        generation: Some(AgentGenerationModel {
            priority: Number(60.0),
            model: String::new(),
        }),
        discover: Some(Box::new({
            let runtime = runtime.clone();
            move |_| {
                let runtime = runtime.clone();
                async move {
                    Ok(runtime
                        .get_models()
                        .await
                        .into_iter()
                        .map(|entry| AgentModelOption {
                            value: entry.value,
                            label: entry.label,
                            supports_images: entry.supports_images,
                            thinking_modes: entry.thinking_modes,
                            is_local: None,
                            api_provider_id: None,
                            endpoint_id: None,
                            raw_model: None,
                            protocol: None,
                        })
                        .collect())
                }
                .boxed_local()
            }
        })),
    };
    let lifecycle = create_lifecycle(runtime.clone());
    let migration = Version1RecordMigration {
        settings: settings.clone(),
        native_sessions: Some(PathNativeSessionCodec::new("opencode")),
        translate_model: None,
    };
    let legacy_history_import = create_history_import({
        let native = native.clone();
        async move |request| native.load_evidence(request, true).await
    });
    let native_history_import = create_native_history_import({
        let native = native.clone();
        async move |request| native.load(request).await
    });
    AgentIntegration {
        descriptor: descriptor(),
        literal_execution: None,
        attachments: Some(AgentAttachments {
            file_mime_types: FileAttachmentMimeTypes::Listed(
                ["text/markdown", "text/plain"]
                    .into_iter()
                    .chain(DOCUMENT_FILE_ATTACHMENT_MIME_TYPES.iter().copied())
                    .chain(VIDEO_FILE_ATTACHMENT_MIME_TYPES.iter().copied())
                    .map(str::to_owned)
                    .collect(),
            ),
            inline_text_max_bytes: None,
        }),
        execution: producer.clone(),
        producers: producer.clone(),
        permissions: producer.clone(),
        catalog: Rc::new(catalog),
        settings,
        lifecycle: Rc::new(lifecycle),
        migration: Rc::new(migration),
        readiness: None,
        auth: Some(Rc::new(Auth(runtime.clone()))),
        commands: None,
        compaction: Some(Rc::new(Compaction {
            producer: producer.clone(),
            execution: execution.clone(),
        })),
        forking: Some(Rc::new(OpenCodeNativeForking {
            runtime: runtime.clone(),
            native_sessions: native_sessions.clone(),
            logger: logger.clone(),
        })),
        steering: Some(create_agent_steering(
            producer,
            Rc::new(Steering(runtime.clone())),
            new_id,
        )),
        endpoints: None,
        single_query: Some(Rc::new(SingleQuery(runtime.clone()))),
        legacy_history_import: Some(Rc::new(legacy_history_import)),
        native_history_import: Some(Rc::new(native_history_import)),
        native_activity: Some(Rc::new(OpenCodeNativeActivity {
            runtime,
            native_sessions,
            logger,
        })),
        native_sessions: Some(native),
        configuration_validation: None,
        session_configuration: Some(execution),
        project_path_updates: Some(project_path_updates),
        usage_history: None,
        cli_updates: None,
    }
}

pub(crate) fn create_lifecycle(runtime: Rc<OpenCodeRuntime>) -> IntegrationLifecycle {
    IntegrationLifecycle::new(IntegrationLifecycleOptions {
        start: Some(Box::new({
            let runtime = runtime.clone();
            move || {
                let runtime = runtime.clone();
                async move {
                    runtime.start_purge_timer();
                    Ok(())
                }
                .boxed_local()
            }
        })),
        stop: Some(Box::new({
            let runtime = runtime.clone();
            move || {
                let runtime = runtime.clone();
                async move {
                    runtime.shutdown().await;
                    Ok(())
                }
                .boxed_local()
            }
        })),
        migrate_owned_storage: None,
    })
}

struct Auth(Rc<OpenCodeRuntime>);

#[async_trait(?Send)]
impl AgentAuth for Auth {
    async fn status(&self, signal: CancellationToken) -> ExecutorResult<AgentAuthStatus> {
        AbortSignal::from_token(signal).throw_if_aborted()?;
        Ok(get_open_code_auth_status(Some(self.0.as_ref())))
    }

    fn login_capabilities(&self) -> AgentAuthLoginCapabilities {
        AgentAuthLoginCapabilities::default()
    }
}

struct SingleQuery(Rc<OpenCodeRuntime>);

#[async_trait(?Send)]
impl AgentSingleQuery for SingleQuery {
    async fn run(&self, request: AgentSingleQueryRequest) -> ExecutorResult<String> {
        self.0.run_isolated_query(request).await
    }

    fn runs_tools_without_permission(&self) -> bool {
        false
    }
}

struct Compaction {
    producer: Rc<AgentProducerAdapter>,
    execution: Rc<OpenCodeExecution>,
}

#[async_trait(?Send)]
impl AgentCompaction for Compaction {
    async fn compact(
        &self,
        request: AgentResumeRequestV5,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        let (handle, ()) = self
            .producer
            .run_existing(
                request,
                |request, publish| self.execution.compact(request, publish),
                options,
            )
            .await?;
        Ok(handle)
    }
}

struct Steering(Rc<OpenCodeRuntime>);

#[async_trait(?Send)]
impl RuntimeSteering for Steering {
    fn capture_target(&self, id: &str) -> Option<RuntimeSteerTarget> {
        self.0.steering.capture_target(id)
    }

    async fn steer(&self, request: RuntimeSteerRequest) -> ExecutorResult<AgentSteerResult> {
        self.0.steering.steer(request).await
    }
}

#[async_trait(?Send)]
impl OpenCodeProjectPathRuntime for OpenCodeExecution {
    async fn move_session(
        &self,
        id: &str,
        directory: &str,
        signal: AbortSignal,
    ) -> ExecutorResult<()> {
        self.runtime.move_session(id, directory, signal).await
    }
}

struct OpenCodeNativeEvidence {
    runtime: Rc<OpenCodeRuntime>,
    native_sessions: Rc<PathNativeSessionCodec>,
    logger: Rc<dyn AgentLogger>,
}

impl OpenCodeNativeEvidence {
    async fn load_evidence(
        &self,
        request: AgentNativeEvidenceRequest,
        legacy: bool,
    ) -> ExecutorResult<AgentNativeEvidenceSnapshot> {
        let signal = AbortSignal::from_token(request.signal);
        signal.throw_if_aborted()?;
        let id = resolve_session_id(&self.native_sessions, &request.chat)?;
        let load_signal = &signal;
        let result = self
            .runtime
            .with_client_lease(
                |client| async move {
                    if legacy && id.as_deref().is_none_or(str::is_empty) {
                        return Ok(Vec::new());
                    }
                    load_required_open_code_chat_messages(
                        id.as_deref(),
                        client.as_ref(),
                        &HistoryLoadOptions {
                            directory: Some(&request.chat.project_path),
                            signal: load_signal,
                            throw_on_error: true,
                            logger: self.logger.as_ref(),
                            limit: None,
                        },
                        &SystemClock,
                    )
                    .await
                },
                Some(signal.clone()),
            )
            .await;
        match result {
            Ok(messages) => Ok(AgentNativeEvidenceSnapshot { messages }),
            Err(error) if !legacy && error.is::<OpenCodeTranscriptNotFoundError>() => Err(AgentIntegrationError::new(
                AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
                "The OpenCode native session is missing or outside the recorded project directory",
                false, None,
            ).into()),
            Err(error) => Err(error),
        }
    }
}

#[async_trait(?Send)]
impl AgentNativeEvidenceSource for OpenCodeNativeEvidence {
    async fn load(
        &self,
        request: AgentNativeEvidenceRequest,
    ) -> ExecutorResult<AgentNativeEvidenceSnapshot> {
        self.load_evidence(request, false).await
    }
}

#[async_trait(?Send)]
impl AgentNativeSessionAccess for OpenCodeNativeEvidence {
    async fn resolve_native_session(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        AbortSignal::from_token(request.signal).throw_if_aborted()?;
        Ok(resolve_session_id(&self.native_sessions, &request.chat)?
            .filter(|id| !id.is_empty())
            .and_then(|id| encode_session(&self.native_sessions, &id)))
    }

    async fn describe_source(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentTranscriptSourceLocation>> {
        AbortSignal::from_token(request.signal).throw_if_aborted()?;
        Ok(resolve_session_id(&self.native_sessions, &request.chat)?
            .filter(|id| !id.is_empty())
            .map(|value| AgentTranscriptSourceLocation::ProviderReference { value }))
    }

    async fn release(&self, request: AgentNativeSessionReleaseRequest) -> ExecutorResult<()> {
        AbortSignal::from_token(request.request.signal).throw_if_aborted()?;
        let chat = request.request.chat;
        let id = resolve_session_id(&self.native_sessions, &chat)?;
        self.runtime
            .release_session(&chat.chat_id, id.as_deref())
            .await
    }
}

#[cfg(test)]
mod tests {
    use garcon_agents_common::direct::conformance_host::conformance_host;
    use garcon_interface::testing::{
        AgentIntegrationConformanceOptions, run_agent_integration_conformance,
    };
    use garcon_interface::transcript::AgentChatReference;
    use tokio::task::LocalSet;

    use super::*;

    #[tokio::test]
    async fn opencode_conforms_to_the_integration_contract() {
        LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let class = OpenCodeAgentIntegration;
                let integration =
                    class.create(conformance_host(class.integration_id(), root.path()).unwrap());
                assert!(integration.native_sessions.is_some());
                assert!(integration.legacy_history_import.is_some());
                assert!(integration.native_history_import.is_some());
                assert!(integration.native_activity.is_some());
                assert!(integration.forking.is_some());
                assert!(integration.compaction.is_some());
                assert!(integration.steering.is_some());
                assert!(integration.single_query.is_some());
                assert!(integration.endpoints.is_none());
                run_agent_integration_conformance(AgentIntegrationConformanceOptions {
                    integration_id: class.integration_id(),
                    api_version: class.api_version(),
                    integration: &integration,
                })
                .await
                .unwrap();
            })
            .await;
    }

    #[tokio::test]
    async fn resolves_a_path_only_legacy_session_without_starting_opencode() {
        let root = tempfile::tempdir().unwrap();
        let class = OpenCodeAgentIntegration;
        let integration =
            class.create(conformance_host(class.integration_id(), root.path()).unwrap());
        let evidence = integration.native_sessions.as_ref().unwrap();
        let request = AgentHistoryImportRequest {
            chat: AgentChatReference {
                chat_id: "chat".to_owned(),
                agent_id: "opencode".to_owned(),
                agent_session_id: None,
                project_path: "/project".to_owned(),
                model: String::new(),
                native_session: Some(AgentNativeSessionRef {
                    owner_id: "opencode".to_owned(),
                    schema_version: 1,
                    value: json!({"path":"!opencode:legacy"}).into(),
                }),
                carry_over_revision: String::new(),
                native_seed_receipt: None,
                settings: integration.settings.defaults().unwrap(),
            },
            signal: CancellationToken::new(),
        };
        assert_eq!(
            evidence
                .resolve_native_session(request.clone())
                .await
                .unwrap(),
            encode_session(&PathNativeSessionCodec::new("opencode"), "legacy")
        );
        assert_eq!(
            evidence.describe_source(request).await.unwrap(),
            Some(AgentTranscriptSourceLocation::ProviderReference {
                value: "legacy".to_owned()
            })
        );
    }
}
