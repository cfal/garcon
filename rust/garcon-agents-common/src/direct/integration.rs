//! Shared construction of the facets common to the three Direct integrations.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_contract::{
    agent_execution::{AgentAuthSource, AgentAuthStatus, AgentEndpointSelection},
    agent_integration::{AgentDescriptor, AgentSettingsEnvelope},
    api_providers::ApiProtocol,
    attachments::{FileAttachmentMimeTypes, MAX_INLINE_TEXT_ATTACHMENT_BYTES},
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    host::{AgentApiProviderReader, AgentHost},
    integration::AgentIntegration,
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

use crate::{
    catalog::model_catalog::ModelCatalog,
    execution::{
        admission::check_signal, producer_adapter::create_agent_producer_adapter,
        project_path_adapter::create_agent_project_path_updates,
        resolve_endpoint::resolve_agent_endpoint,
    },
    lifecycle::integration_lifecycle::{IntegrationLifecycle, IntegrationLifecycleOptions},
    migration::version_1_record_migration::Version1RecordMigration,
    settings::versioned_settings::VersionedSettings,
};

use super::{
    errors::classify_direct_integration_error,
    execution::DirectExecution,
    native_session::DirectNativeSessions,
    router::{DirectCompatibleRuntime, DirectEndpointRouterRuntime, DirectRuntimeFamilyOptions},
    session_store::{DirectSessionStore, DirectSessionStoreOptions},
    single_query_options::DirectSingleQueryOptions,
};

pub struct DirectIntegrationOptions {
    pub descriptor: AgentDescriptor,
    pub file_mime_types: Vec<String>,
    pub generation_priority: Number,
    pub endpoint_protocol: ApiProtocol,
    pub incompatible_endpoint_message: &'static str,
    pub missing_endpoint_message: &'static str,
}

pub fn create_direct_integration<R: DirectCompatibleRuntime + 'static>(
    host: AgentHost,
    options: DirectIntegrationOptions,
    create_runtime: impl FnOnce(DirectRuntimeFamilyOptions) -> DirectEndpointRouterRuntime<R>,
) -> AgentIntegration {
    let sessions = DirectSessionStore::new(DirectSessionStoreOptions {
        agent_id: host.agent_id,
        storage: host.storage,
        now: None,
        read_file: None,
        sync_directory: None,
    });
    let runtime = Rc::new(create_runtime(DirectRuntimeFamilyOptions {
        runtime_label: options.descriptor.label.clone(),
        sessions: sessions.clone(),
    }));
    let native = Rc::new(DirectNativeSessions(sessions));
    let settings = Rc::new(VersionedSettings::new(
        AgentSettingsEnvelope {
            owner_id: options.descriptor.id.clone(),
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
                check_signal(Some(&request.signal))?;
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
            priority: options.generation_priority,
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
        descriptor: options.descriptor,
        literal_execution: None,
        attachments: Some(AgentAttachments {
            file_mime_types: FileAttachmentMimeTypes::Listed(options.file_mime_types),
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
        endpoints: Some(Rc::new(Endpoints {
            protocol: options.endpoint_protocol,
            incompatible_endpoint_message: options.incompatible_endpoint_message,
        })),
        single_query: Some(Rc::new(SingleQuery {
            api_providers: host.api_providers,
            runtime,
            missing_endpoint_message: options.missing_endpoint_message,
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

struct Auth;

#[async_trait(?Send)]
impl AgentAuth for Auth {
    async fn status(&self, signal: CancellationToken) -> ExecutorResult<AgentAuthStatus> {
        check_signal(Some(&signal))?;
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

struct Endpoints {
    protocol: ApiProtocol,
    incompatible_endpoint_message: &'static str,
}

#[async_trait(?Send)]
impl AgentEndpoints for Endpoints {
    async fn validate(
        &self,
        selection: AgentEndpointSelection,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        if selection.protocol != self.protocol {
            return Err(invalid_endpoint(self.incompatible_endpoint_message));
        }
        Ok(())
    }
}

struct SingleQuery<R> {
    api_providers: Rc<dyn AgentApiProviderReader>,
    runtime: Rc<DirectEndpointRouterRuntime<R>>,
    missing_endpoint_message: &'static str,
}

#[async_trait(?Send)]
impl<R: DirectCompatibleRuntime> AgentSingleQuery for SingleQuery<R> {
    async fn run(&self, request: AgentSingleQueryRequest) -> ExecutorResult<String> {
        let endpoint = resolve_agent_endpoint(
            self.api_providers.as_ref(),
            request.endpoint,
            &request.signal,
        )
        .await?
        .ok_or_else(|| invalid_endpoint(self.missing_endpoint_message))?;
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
