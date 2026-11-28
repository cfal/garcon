//! The native Antigravity agent integration.

pub mod antigravity_account;
pub mod antigravity_acp_event_converter;
pub mod antigravity_acp_policy;
pub mod antigravity_auth;
pub mod antigravity_models;
pub mod config;
pub mod plan_schedule_result;
pub mod report_text;
pub mod run_single_query;
pub mod tool_call_snapshot;
pub mod tool_use_converter;

use std::rc::Rc;

use async_trait::async_trait;
use garcon_agents_common::{
    acp::{
        agent_runtime::{AcpAgentRuntime, AcpAgentRuntimeOptions},
        execution::AcpExecution,
    },
    chats::artificial_native_path::get_artificial_agent_session_id,
    execution::{
        control_adapters::{RuntimeSteering, create_agent_steering},
        producer_adapter::create_agent_producer_adapter,
        runtime_events::{RuntimeSteerRequest, RuntimeSteerTarget},
    },
    lifecycle::integration_lifecycle::{IntegrationLifecycle, IntegrationLifecycleOptions},
    logging::scoped_agent_logger::create_scoped_agent_logger,
    migration::version_1_record_migration::Version1RecordMigration,
    native_session::path_native_session::{PathNativeSessionCodec, PathNativeSessionValue},
    settings::versioned_settings::VersionedSettings,
};
use garcon_contract::{
    agent_integration::{
        AgentConfigurationDescriptor, AgentConfigurationSource, AgentDescriptor,
        AgentSettingsEnvelope,
    },
    chat_modes::PERMISSION_MODE_VALUES,
};
use garcon_interface::{
    host::AgentHost,
    integration::{AGENT_INTEGRATION_API_VERSION, AgentIntegration, AgentIntegrationClass},
    native_history::{
        AgentHistoryImportRequest, AgentNativeSessionAccess, AgentNativeSessionReleaseRequest,
    },
    resources::ExecutorResult,
    services::AgentSteerResult,
    transcript::{AgentChatReference, AgentNativeSessionRef, AgentTranscriptSourceLocation},
};
use serde_json::{Value, json};

use crate::{
    antigravity_account::AntigravityAccount,
    antigravity_acp_event_converter::AntigravityAcpEventConverter,
    antigravity_acp_policy::{
        ANTIGRAVITY_AGENT_ID, create_antigravity_acp_policy, create_antigravity_native_path,
    },
    antigravity_auth::check_signal,
    config::AntigravityConfig,
    run_single_query::AntigravitySingleQuery,
};

pub fn antigravity_descriptor() -> AgentDescriptor {
    AgentDescriptor {
        id: ANTIGRAVITY_AGENT_ID.into(), label: "Antigravity".into(), icon: None,
        supported_permission_modes: PERMISSION_MODE_VALUES.to_vec(), supported_thinking_modes: vec![],
        supports_images: true, supports_project_path_update: false,
        requires_native_path_for_project_path_update: false, supported_endpoint_protocols: vec![],
        configuration: [
            ("GARCON_ANTIGRAVITY_BINARY", "Antigravity CLI (agy) binary."),
            ("GARCON_ANTIGRAVITY_AUTH_METHOD", "Antigravity ACP auth method: oauth-personal, oauth-business, gemini-api-key, or agent-platform."),
            ("GEMINI_API_KEY", "Gemini API key; selects the gemini-api-key auth method unless one is configured."),
        ].into_iter().map(|(key, description)| AgentConfigurationDescriptor {
            key: key.into(), source: AgentConfigurationSource::Environment, description: description.into(),
        }).collect(),
    }
}

pub struct AntigravityAgentIntegration;

impl AgentIntegrationClass for AntigravityAgentIntegration {
    fn integration_id(&self) -> &str {
        ANTIGRAVITY_AGENT_ID
    }

    fn api_version(&self) -> u64 {
        AGENT_INTEGRATION_API_VERSION
    }

    fn create(&self, host: AgentHost) -> AgentIntegration {
        let config = AntigravityConfig::new(host.environment);
        let logger = create_scoped_agent_logger(host.logger.clone(), ANTIGRAVITY_AGENT_ID);
        let native_sessions = Rc::new(PathNativeSessionCodec::new(ANTIGRAVITY_AGENT_ID));
        let runtime = AcpAgentRuntime::new(
            create_antigravity_acp_policy(config.clone()),
            AcpAgentRuntimeOptions {
                converter: Rc::new(AntigravityAcpEventConverter::default()),
                logger: Some(logger.clone()),
                create_transport: None,
                cancel_settle_timeout_ms: None,
                steer_decision_timeout_ms: None,
                clock: None,
                new_permission_id: None,
            },
        );
        let account = Rc::new(AntigravityAccount::new(config.clone(), logger));
        let settings = Rc::new(VersionedSettings::new(
            AgentSettingsEnvelope {
                owner_id: ANTIGRAVITY_AGENT_ID.into(),
                schema_version: 1,
                values: json!({}).into(),
            },
            vec![],
            None,
        ));
        let execution = Rc::new(AcpExecution {
            runtime: runtime.clone(),
            native_sessions: native_sessions.clone(),
        });
        let new_id: Rc<dyn Fn() -> String> = Rc::new(|| uuid::Uuid::new_v4().to_string());
        let producer = create_agent_producer_adapter(
            execution.clone(),
            host.logger,
            host.scope,
            new_id.clone(),
        );
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
                let account = account.clone();
                move || {
                    let runtime = runtime.clone();
                    let account = account.clone();
                    Box::pin(async move {
                        account.stop();
                        runtime.shutdown();
                        Ok(())
                    })
                }
            })),
            migrate_owned_storage: None,
        });
        AgentIntegration {
            descriptor: antigravity_descriptor(),
            literal_execution: None,
            attachments: None,
            execution: producer.clone(),
            producers: producer.clone(),
            permissions: producer.clone(),
            catalog: account.catalog.clone(),
            settings: settings.clone(),
            lifecycle: Rc::new(lifecycle),
            migration: Rc::new(Version1RecordMigration {
                settings,
                native_sessions: Some(PathNativeSessionCodec::new(ANTIGRAVITY_AGENT_ID)),
                translate_model: None,
            }),
            readiness: None,
            auth: Some(account.auth.clone()),
            commands: None,
            compaction: None,
            forking: None,
            steering: Some(create_agent_steering(
                producer,
                Rc::new(Steering(runtime.clone())),
                new_id,
            )),
            endpoints: None,
            single_query: Some(Rc::new(AntigravitySingleQuery(config))),
            legacy_history_import: None,
            native_history_import: None,
            native_activity: None,
            native_sessions: Some(Rc::new(NativeSessions {
                codec: native_sessions,
                runtime,
            })),
            configuration_validation: None,
            session_configuration: Some(execution),
            project_path_updates: None,
            usage_history: None,
            cli_updates: None,
        }
    }
}

struct Steering(AcpAgentRuntime);

#[async_trait(?Send)]
impl RuntimeSteering for Steering {
    fn capture_target(&self, id: &str) -> Option<RuntimeSteerTarget> {
        self.0.capture_steer_target(id)
    }

    async fn steer(&self, request: RuntimeSteerRequest) -> ExecutorResult<AgentSteerResult> {
        self.0.steer(request).await
    }
}

struct NativeSessions {
    codec: Rc<PathNativeSessionCodec>,
    runtime: AcpAgentRuntime,
}

impl NativeSessions {
    fn session_id(&self, chat: &AgentChatReference) -> ExecutorResult<Option<String>> {
        let native = self.codec.decode(chat.native_session.as_ref())?;
        Ok(chat
            .agent_session_id
            .clone()
            .or(native.agent_session_id)
            .or_else(|| {
                get_artificial_agent_session_id(
                    &native.path.map_or(Value::Null, Value::from),
                    [ANTIGRAVITY_AGENT_ID],
                )
            }))
    }
}

#[async_trait(?Send)]
impl AgentNativeSessionAccess for NativeSessions {
    async fn resolve_native_session(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        check_signal(&request.signal)?;
        let Some(id) = self.session_id(&request.chat)?.filter(|id| !id.is_empty()) else {
            return Ok(None);
        };
        Ok(self.codec.encode(PathNativeSessionValue {
            path: create_antigravity_native_path(&id),
            agent_session_id: Some(id),
            model_endpoint_id: None,
        }))
    }

    async fn describe_source(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentTranscriptSourceLocation>> {
        check_signal(&request.signal)?;
        let Some(id) = self.session_id(&request.chat)?.filter(|id| !id.is_empty()) else {
            return Ok(None);
        };
        let home = std::env::home_dir().ok_or("Could not resolve the executor's home directory")?;
        let path = garcon_js::path::native::join(&[
            &home.to_string_lossy(),
            ".gemini",
            "antigravity-cli",
            "conversations",
            &format!("{id}.db"),
        ]);
        Ok(Some(AgentTranscriptSourceLocation::FilesystemPath {
            value: path,
        }))
    }

    async fn release(&self, request: AgentNativeSessionReleaseRequest) -> ExecutorResult<()> {
        let request = request.request;
        check_signal(&request.signal)?;
        self.runtime.release_session(
            &request.chat.chat_id,
            self.session_id(&request.chat)?.as_deref(),
        );
        Ok(())
    }
}
