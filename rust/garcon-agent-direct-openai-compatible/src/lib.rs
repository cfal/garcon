//! Ports `server-agents/direct-openai-compatible/src/index.ts`.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_agents_common::{
    catalog::model_catalog::ModelCatalog,
    direct::{
        direct_chat_runtime_base::DirectChatRuntimeBase,
        errors::classify_direct_integration_error,
        execution::DirectExecution,
        native_session::DirectNativeSessions,
        openai_compatible_chat_runtime::OpenAiCompatibleChatProtocol,
        router::{
            DirectEndpointRouterRuntime, DirectRuntimeFamilyOptions,
            create_direct_open_ai_chat_runtime,
        },
        session_store::{DirectSessionStore, DirectSessionStoreOptions},
        single_query_options::DirectSingleQueryOptions,
    },
    execution::{
        producer_adapter::create_agent_producer_adapter,
        project_path_adapter::create_agent_project_path_updates,
        resolve_endpoint::resolve_agent_endpoint,
    },
    lifecycle::integration_lifecycle::{IntegrationLifecycle, IntegrationLifecycleOptions},
    migration::version_1_record_migration::Version1RecordMigration,
    settings::versioned_settings::VersionedSettings,
};
use garcon_base::errors::NamedError;
use garcon_contract::{
    agent_execution::{AgentAuthSource, AgentAuthStatus, AgentEndpointSelection},
    agent_integration::{AgentDescriptor, AgentSettingsEnvelope},
    agents::{
        DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID as ID,
        DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL as LABEL,
    },
    api_providers::ApiProtocol,
    attachments::{
        FileAttachmentMimeTypes, MAX_INLINE_TEXT_ATTACHMENT_BYTES, TEXT_FILE_ATTACHMENT_MIME_TYPES,
    },
    chat_modes::{PERMISSION_MODE_VALUES, PermissionMode, THINKING_MODE_VALUES},
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    host::{AgentApiProviderReader, AgentHost},
    integration::{AGENT_INTEGRATION_API_VERSION, AgentIntegration, AgentIntegrationClass},
    resources::{ExecutorCallOptions, ExecutorResult},
    services::{
        AgentAttachments, AgentAuth, AgentAuthLoginCapabilities, AgentEndpoints,
        AgentGenerationModel, AgentSingleQuery, AgentSingleQueryRequest,
    },
};
use garcon_js::Number;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

type Runtime = DirectEndpointRouterRuntime<DirectChatRuntimeBase<OpenAiCompatibleChatProtocol>>;

pub struct DirectOpenAiCompatibleIntegration;

impl AgentIntegrationClass for DirectOpenAiCompatibleIntegration {
    fn integration_id(&self) -> &str {
        ID
    }

    fn api_version(&self) -> u64 {
        AGENT_INTEGRATION_API_VERSION
    }

    fn create(&self, host: AgentHost) -> AgentIntegration {
        let sessions = DirectSessionStore::new(DirectSessionStoreOptions {
            agent_id: host.agent_id,
            storage: host.storage,
            now: None,
            read_file: None,
            sync_directory: None,
        });
        let runtime = Rc::new(create_direct_open_ai_chat_runtime(
            DirectRuntimeFamilyOptions {
                runtime_label: LABEL.into(),
                sessions: sessions.clone(),
            },
        ));
        let native = Rc::new(DirectNativeSessions(sessions));
        let settings = Rc::new(VersionedSettings::new(
            AgentSettingsEnvelope {
                owner_id: ID.into(),
                schema_version: 1,
                values: json!({}).into(),
            },
            Vec::new(),
            None,
        ));
        let new_id: Rc<dyn Fn() -> String> = Rc::new(|| Uuid::new_v4().to_string());
        let project_path_updates = create_agent_project_path_updates(
            host.scope.clone(),
            Rc::new(|request| {
                Box::pin(async move {
                    check_signal(&request.signal)?;
                    Ok(None)
                })
            }),
            new_id.clone(),
        );
        let producer = create_agent_producer_adapter(
            Rc::new(DirectExecution {
                api_providers: host.api_providers.clone(),
                runtime: runtime.clone(),
            }),
            host.logger.clone(),
            host.scope,
            new_id,
        );
        let catalog = ModelCatalog {
            logger: host.logger,
            default_model: String::new(),
            fallback_models: Vec::new(),
            requires_strict_model_discovery: false,
            generation: Some(AgentGenerationModel {
                priority: Number(50.0),
                model: String::new(),
            }),
            discover: None,
        };
        let lifecycle = IntegrationLifecycle::new(IntegrationLifecycleOptions {
            start: Some(Box::new({
                let runtime = runtime.clone();
                move || {
                    let runtime = runtime.clone();
                    Box::pin(async move {
                        runtime.start_purge_timer();
                        Ok(())
                    })
                }
            })),
            stop: Some(Box::new({
                let runtime = runtime.clone();
                move || {
                    let runtime = runtime.clone();
                    Box::pin(async move {
                        runtime.shutdown();
                        Ok(())
                    })
                }
            })),
            migrate_owned_storage: None,
        });
        let migration = Version1RecordMigration {
            settings: settings.clone(),
            native_sessions: None,
            translate_model: None,
        };
        AgentIntegration {
            descriptor: descriptor(),
            literal_execution: None,
            attachments: Some(AgentAttachments {
                file_mime_types: FileAttachmentMimeTypes::Listed(
                    TEXT_FILE_ATTACHMENT_MIME_TYPES
                        .iter()
                        .copied()
                        .map(str::to_owned)
                        .collect(),
                ),
                inline_text_max_bytes: Some(Number(MAX_INLINE_TEXT_ATTACHMENT_BYTES as f64)),
            }),
            execution: producer.clone(),
            producers: producer.clone(),
            permissions: producer,
            catalog: Rc::new(catalog),
            settings,
            lifecycle: Rc::new(lifecycle),
            migration: Rc::new(migration),
            readiness: None,
            auth: Some(Rc::new(Auth)),
            commands: None,
            compaction: None,
            forking: None,
            steering: None,
            endpoints: Some(Rc::new(Endpoints)),
            single_query: Some(Rc::new(SingleQuery {
                api_providers: host.api_providers,
                runtime,
            })),
            legacy_history_import: None,
            native_history_import: Some(native.clone()),
            native_activity: None,
            native_sessions: Some(native),
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
        id: ID.into(),
        label: LABEL.into(),
        icon: None,
        supported_permission_modes: PERMISSION_MODE_VALUES
            .iter()
            .copied()
            .filter(|mode| *mode != PermissionMode::Plan)
            .collect(),
        supported_thinking_modes: THINKING_MODE_VALUES.to_vec(),
        supports_images: true,
        supports_project_path_update: true,
        requires_native_path_for_project_path_update: false,
        supported_endpoint_protocols: vec![ApiProtocol::OpenAiCompatible],
        configuration: Vec::new(),
    }
}

struct Auth;

#[async_trait(?Send)]
impl AgentAuth for Auth {
    async fn status(&self, signal: CancellationToken) -> ExecutorResult<AgentAuthStatus> {
        check_signal(&signal)?;
        Ok(AgentAuthStatus {
            authenticated: false,
            can_reauth: false,
            label: String::new(),
            source: AgentAuthSource::None,
            detail: None,
        })
    }

    fn login_capabilities(&self) -> AgentAuthLoginCapabilities {
        AgentAuthLoginCapabilities::default()
    }
}

struct Endpoints;

#[async_trait(?Send)]
impl AgentEndpoints for Endpoints {
    async fn validate(
        &self,
        selection: AgentEndpointSelection,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        if selection.protocol != ApiProtocol::OpenAiCompatible {
            return Err(invalid_endpoint(
                "OpenAI Compatible requires an OpenAI-compatible endpoint",
            ));
        }
        Ok(())
    }
}

struct SingleQuery {
    api_providers: Rc<dyn AgentApiProviderReader>,
    runtime: Rc<Runtime>,
}

#[async_trait(?Send)]
impl AgentSingleQuery for SingleQuery {
    async fn run(&self, request: AgentSingleQueryRequest) -> ExecutorResult<String> {
        let endpoint = resolve_agent_endpoint(
            self.api_providers.as_ref(),
            request.endpoint,
            &request.signal,
        )
        .await?
        .ok_or_else(|| invalid_endpoint("OpenAI Compatible requires an API provider endpoint"))?;
        self.runtime
            .run_single_query(
                request.prompt,
                endpoint,
                DirectSingleQueryOptions {
                    model: request.model,
                    thinking_mode: request.thinking_mode,
                    timeout_ms: request.timeout_ms.map(|timeout| timeout.0),
                    signal: request.signal,
                },
            )
            .await
            .map_err(classify_direct_integration_error)
    }

    fn runs_tools_without_permission(&self) -> bool {
        false
    }
}

fn invalid_endpoint(message: &'static str) -> Box<dyn std::error::Error> {
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::INVALID_ENDPOINT,
        message,
        false,
        None,
    )
    .into()
}

fn check_signal(signal: &CancellationToken) -> ExecutorResult<()> {
    if signal.is_cancelled() {
        return Err(NamedError {
            name: "AbortError".into(),
            message: "The operation was aborted.".into(),
            code: None,
        }
        .into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
