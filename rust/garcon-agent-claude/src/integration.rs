use std::{ffi::OsString, rc::Rc};

use async_trait::async_trait;
use futures::FutureExt;
use garcon_agents_common::{
    auth::cli_login_controller::{
        CliLoginCommand, CliLoginController, CliLoginControllerOptions, CliLoginMode,
    },
    execution::{
        control_adapters::{RuntimeSteering, create_agent_steering},
        producer_adapter::create_agent_producer_adapter,
        project_path_adapter::create_agent_project_path_updates,
        resolve_endpoint::resolve_agent_endpoint,
        runtime_events::{RuntimeSteerRequest, RuntimeSteerTarget},
    },
    forking::jsonl_forking::{JsonlNativeForkingOptions, create_jsonl_native_forking},
    lifecycle::integration_lifecycle::{IntegrationLifecycle, IntegrationLifecycleOptions},
    logging::scoped_agent_logger::create_scoped_agent_logger,
    migration::version_1_record_migration::Version1RecordMigration,
    native_session::{
        evidence_source::{
            AgentNativeEvidenceRequest, AgentNativeEvidenceSnapshot, AgentNativeEvidenceSource,
        },
        native_history_import::{create_history_import, create_native_history_import},
        path_native_session::{PathNativeSessionCodec, PathNativeSessionValue},
    },
    shared::single_query_control::{single_query_runtime_options, with_single_query_directory},
    usage::{
        transcript_usage_history::create_transcript_usage_history,
        transcript_usage_scanner::TranscriptUsageScannerOptions,
    },
};
use garcon_base::{
    errors::{ErrorInput, has_node_error_code},
    executor_disconnect::as_agent_integration_error,
};
use garcon_contract::{
    agent_auth::{AgentAuthLoginCompleteResult, AgentAuthLoginLaunchResult, AgentAuthLoginStatus},
    agent_execution::{AgentAuthSource, AgentAuthStatus, AgentEndpointSelection},
    api_providers::ApiProtocol,
    attachments::FileAttachmentMimeTypes,
    slash_commands::SlashCommand,
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    execution::{AgentConfigurationValidation, AgentSessionConfiguration},
    host::{AgentApiProviderReader, AgentHost, AgentLogger},
    integration::{AGENT_INTEGRATION_API_VERSION, AgentIntegration, AgentIntegrationClass},
    native_history::{AgentNativeSessionAccess, AgentNativeSessionReleaseRequest},
    resources::{ExecutorCallOptions, ExecutorResult},
    services::{
        AgentAttachments, AgentAuth, AgentAuthCompleteLogin, AgentAuthLaunchLogin,
        AgentAuthLoginCapabilities, AgentAuthLoginStatusReader, AgentCommands, AgentEndpoints,
        AgentSingleQuery, AgentSingleQueryRequest, AgentSteerResult,
    },
    transcript::{AgentChatReference, AgentNativeSessionRef, AgentTranscriptSourceLocation},
};
use garcon_js::SystemClock;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::{
    claude_auth::{ClaudeAuthStatus, get_claude_auth_status},
    claude_auth_login::{parse_claude_auth_login_error, validate_claude_auth_code},
    claude_catalog,
    claude_cli::ClaudeCli,
    claude_descriptor, claude_settings,
    cli_invocation::{ClaudeSingleQueryOptions, run_single_query},
    cli_updates::create_claude_cli_updates,
    config::{ClaudeConfig, create_claude_config},
    endpoint_runtime::{
        build_claude_endpoint_runtime, build_claude_host_environment,
        build_claude_process_environment,
    },
    execution::{ClaudeExecution, check_signal, invalid_endpoint, system_home_dir},
    fork_transcript::{
        claude_fork_semantic_digest, create_claude_fork_transcript_transformer,
        project_claude_fork_entry,
    },
    history_loader::load_claude_chat_messages,
    model_context::resolve_claude_model,
    native_activity::create_claude_native_activity_probe,
    native_path::{
        ClaudeNativePathOptions, ClaudeNativePathSession, claude_projects_dir,
        resolve_claude_native_path,
    },
    slash_command_discovery::ClaudeSlashCommandDiscovery,
    usage_format::ClaudeUsageFormat,
};

pub struct ClaudeAgentIntegration;

impl AgentIntegrationClass for ClaudeAgentIntegration {
    fn integration_id(&self) -> &str {
        "claude"
    }

    fn api_version(&self) -> u64 {
        AGENT_INTEGRATION_API_VERSION
    }

    fn create(&self, host: AgentHost) -> AgentIntegration {
        let host = Rc::new(host);
        let config = create_claude_config(host.environment.clone());
        let logger = create_scoped_agent_logger(host.logger.clone(), "claude");
        let native_sessions = Rc::new(PathNativeSessionCodec::new("claude"));
        let new_id: Rc<dyn Fn() -> String> = Rc::new(|| uuid::Uuid::new_v4().to_string());
        let executable = Rc::new({
            let config = config.clone();
            move || config.binary().map(OsString::from)
        });
        let runtime = ClaudeCli::with_executable_reader(executable.clone(), logger.clone());

        let mut options = CliLoginControllerOptions::new(
            {
                let executable = executable.clone();
                move || {
                    Ok(CliLoginCommand {
                        executable: executable()?,
                        args: ["auth".into(), "login".into()].into(),
                    })
                }
            },
            CliLoginMode::BrowserCode,
            logger.clone(),
        );
        options.validate_code = Some(Rc::new(validate_claude_auth_code));
        options.parse_output_error = Some(Rc::new(parse_claude_auth_login_error));
        options.environment = Some(Rc::new({
            let config = config.clone();
            move || {
                let mut environment = build_claude_process_environment(&config)?;
                environment.extend([
                    ("TERM".into(), "xterm-256color".into()),
                    ("COLORTERM".into(), "truecolor".into()),
                    ("FORCE_COLOR".into(), "3".into()),
                ]);
                Ok(environment)
            }
        }));
        let login = CliLoginController::new(options);
        let commands = Rc::new(ClaudeSlashCommandDiscovery::new(
            executable,
            Rc::new({
                let config = config.clone();
                move || {
                    Ok(os_environment(
                        build_claude_host_environment(&config)?
                            .into_iter()
                            .flatten(),
                    ))
                }
            }),
            logger.clone(),
        ));
        let settings = Rc::new(claude_settings());
        let provider_execution = Rc::new(ClaudeExecution {
            host: host.clone(),
            runtime: runtime.clone(),
            native_sessions: native_sessions.clone(),
            logger: logger.clone(),
            config: config.clone(),
            new_session_id: new_id.clone(),
        });
        let project_path_updates = create_agent_project_path_updates(
            host.scope.clone(),
            Rc::new({
                let execution = provider_execution.clone();
                move |request| {
                    let execution = execution.clone();
                    async move { execution.prepare_project_path_update(request).await }
                        .boxed_local()
                }
            }),
            new_id.clone(),
        );
        let evidence = Rc::new(ClaudeNativeEvidence {
            runtime: runtime.clone(),
            native_sessions: native_sessions.clone(),
            config: config.clone(),
            logger: logger.clone(),
        });
        let producer = create_agent_producer_adapter(
            provider_execution.clone(),
            host.logger.clone(),
            host.scope.clone(),
            new_id.clone(),
        );
        // INFALLIBLE: The default activity tail bound is a positive safe integer.
        let activity = create_claude_native_activity_probe(native_sessions.clone())
            .expect("default native activity tail bound");
        let usage_history = create_transcript_usage_history(TranscriptUsageScannerOptions {
            operation: "claude-usage-history".into(),
            format: ClaudeUsageFormat,
            roots: Rc::new({
                let config = config.clone();
                move || {
                    let home = system_home_dir();
                    let config_home_dir = config.config_home_dir()?;
                    Ok(vec![claude_projects_dir(&ClaudeNativePathOptions {
                        home_dir: &home,
                        config_home_dir: config_home_dir.as_deref(),
                        logger: None,
                    })])
                }
            }),
            clock: None,
        });
        let updates = create_claude_cli_updates(
            config.clone(),
            runtime.version_probe.clone(),
            logger.clone(),
        );
        let lifecycle = Rc::new(IntegrationLifecycle::new(IntegrationLifecycleOptions {
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
                let login = login.clone();
                let commands = commands.clone();
                move || {
                    let runtime = runtime.clone();
                    let login = login.clone();
                    let commands = commands.clone();
                    async move {
                        runtime.shutdown().await;
                        login.stop();
                        commands.clear();
                        Ok(())
                    }
                    .boxed_local()
                }
            })),
            migrate_owned_storage: None,
        }));

        AgentIntegration {
            descriptor: claude_descriptor(),
            literal_execution: None,
            readiness: None,
            attachments: Some(AgentAttachments {
                file_mime_types: FileAttachmentMimeTypes::Any,
                inline_text_max_bytes: None,
            }),
            execution: producer.clone(),
            producers: producer.clone(),
            permissions: producer.clone(),
            catalog: Rc::new(claude_catalog(host.logger.clone())),
            settings: settings.clone(),
            lifecycle,
            migration: Rc::new(Version1RecordMigration {
                settings,
                native_sessions: Some(PathNativeSessionCodec::new("claude")),
                translate_model: None,
            }),
            auth: Some(Rc::new(ClaudeAuth {
                config: config.clone(),
                login,
            })),
            commands: Some(commands),
            compaction: None,
            forking: Some(Rc::new(create_jsonl_native_forking(
                JsonlNativeForkingOptions {
                    native_evidence: evidence.clone(),
                    native_sessions,
                    rewrite_entry: Some(Rc::new(project_claude_fork_entry)),
                    create_rewrite_entry: None,
                    fork_whole_session: None,
                    transform_entries: Some(create_claude_fork_transcript_transformer(
                        new_id.clone(),
                        Rc::new(SystemClock),
                    )),
                    create_target_path: None,
                    allow_unmaterialized_whole_session: true,
                    semantic_digest: Some(Rc::new(|rows| {
                        claude_fork_semantic_digest(rows).boxed_local()
                    })),
                },
            ))),
            steering: Some(create_agent_steering(producer, runtime.clone(), new_id)),
            endpoints: Some(Rc::new(ClaudeConfigurationValidation)),
            single_query: Some(Rc::new(ClaudeSingleQuery {
                config,
                api_providers: host.api_providers.clone(),
                logger,
                version_probe: runtime.version_probe.clone(),
            })),
            legacy_history_import: Some(Rc::new(create_history_import({
                let evidence = evidence.clone();
                async move |request| evidence.load_legacy(request).await
            }))),
            native_history_import: Some(Rc::new(create_native_history_import({
                let evidence = evidence.clone();
                async move |request| evidence.load(request).await
            }))),
            native_activity: Some(Rc::new(activity)),
            native_sessions: Some(evidence),
            configuration_validation: Some(Rc::new(ClaudeConfigurationValidation)),
            session_configuration: Some(provider_execution),
            project_path_updates: Some(project_path_updates),
            usage_history: Some(usage_history),
            cli_updates: Some(Rc::new(updates)),
        }
    }
}

struct ClaudeNativeEvidence {
    runtime: Rc<ClaudeCli>,
    native_sessions: Rc<PathNativeSessionCodec>,
    config: ClaudeConfig,
    logger: Rc<dyn AgentLogger>,
}

impl ClaudeNativeEvidence {
    fn reference(&self, chat: &AgentChatReference) -> ExecutorResult<PathNativeSessionValue> {
        let mut native = self.native_sessions.decode(chat.native_session.as_ref())?;
        native.agent_session_id = chat.agent_session_id.clone().or(native.agent_session_id);
        Ok(native)
    }

    async fn resolve_path(
        &self,
        request: &AgentNativeEvidenceRequest,
    ) -> ExecutorResult<Option<String>> {
        check_signal(&request.signal)?;
        let native = self.reference(&request.chat)?;
        let home_dir = system_home_dir();
        let config_home_dir = self.config.config_home_dir()?;
        let resolved = resolve_claude_native_path(
            ClaudeNativePathSession {
                project_path: &request.chat.project_path,
                agent_session_id: native.agent_session_id.as_deref(),
                native_path: native.path.as_deref(),
            },
            &ClaudeNativePathOptions {
                home_dir: &home_dir,
                config_home_dir: config_home_dir.as_deref(),
                logger: Some(self.logger.clone()),
            },
        )
        .await?;
        check_signal(&request.signal)?;
        Ok(resolved)
    }

    async fn load_legacy(
        &self,
        request: AgentNativeEvidenceRequest,
    ) -> ExecutorResult<AgentNativeEvidenceSnapshot> {
        let Some(path) = self.resolve_path(&request).await? else {
            return Ok(AgentNativeEvidenceSnapshot::default());
        };
        match load_claude_chat_messages(Some(&path), Some(self.logger.as_ref()), true).await {
            Ok(messages) => Ok(AgentNativeEvidenceSnapshot { messages }),
            Err(error) if has_node_error_code(ErrorInput::Error(error.as_ref()), "ENOENT") => {
                Ok(AgentNativeEvidenceSnapshot::default())
            }
            Err(error) => Err(error),
        }
    }
}

#[async_trait(?Send)]
impl AgentNativeSessionAccess for ClaudeNativeEvidence {
    async fn resolve_native_session(
        &self,
        request: AgentNativeEvidenceRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        check_signal(&request.signal)?;
        let mut native = self.reference(&request.chat)?;
        if native.agent_session_id.as_deref().is_none_or(str::is_empty) {
            return Ok(None);
        }
        native.path = self.resolve_path(&request).await?;
        if native.path.is_none() && request.chat.native_session.is_some() {
            return Ok(request.chat.native_session);
        }
        Ok(self.native_sessions.encode(native))
    }

    async fn describe_source(
        &self,
        request: AgentNativeEvidenceRequest,
    ) -> ExecutorResult<Option<AgentTranscriptSourceLocation>> {
        Ok(self
            .resolve_path(&request)
            .await?
            .map(|value| AgentTranscriptSourceLocation::FilesystemPath { value }))
    }

    async fn release(&self, release: AgentNativeSessionReleaseRequest) -> ExecutorResult<()> {
        check_signal(&release.request.signal)?;
        let chat = &release.request.chat;
        let native = self.reference(chat)?;
        self.runtime
            .release_session(&chat.chat_id, native.agent_session_id.as_deref())
            .await
    }
}

#[async_trait(?Send)]
impl AgentNativeEvidenceSource for ClaudeNativeEvidence {
    async fn load(
        &self,
        request: AgentNativeEvidenceRequest,
    ) -> ExecutorResult<AgentNativeEvidenceSnapshot> {
        let path = self.resolve_path(&request).await?.ok_or_else(|| {
            AgentIntegrationError::new(
                AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
                "Claude native transcript is unavailable",
                false,
                json!({"reason":"source-missing"}).as_object().cloned(),
            )
        })?;
        Ok(AgentNativeEvidenceSnapshot {
            messages: load_claude_chat_messages(Some(&path), Some(self.logger.as_ref()), true)
                .await?,
        })
    }
}

struct ClaudeAuth {
    config: ClaudeConfig,
    login: CliLoginController,
}

#[async_trait(?Send)]
impl AgentAuth for ClaudeAuth {
    async fn status(&self, signal: CancellationToken) -> ExecutorResult<AgentAuthStatus> {
        check_signal(&signal)?;
        let override_configured = self.config.anthropic_base_url()?.is_some()
            || self.config.anthropic_api_key()?.is_some();
        let status = if override_configured {
            ClaudeAuthStatus {
                authenticated: true,
                can_reauth: false,
                label: String::new(),
            }
        } else {
            // The auth probe catches binary resolution and spawn failures, unlike login launch.
            match self.config.binary() {
                Ok(binary) => get_claude_auth_status(binary.as_ref(), None, None).await,
                Err(_) => ClaudeAuthStatus {
                    authenticated: false,
                    can_reauth: true,
                    label: String::new(),
                },
            }
        };
        Ok(AgentAuthStatus {
            authenticated: status.authenticated,
            can_reauth: true,
            label: if status.label.is_empty() {
                "Claude".into()
            } else {
                status.label
            },
            source: if status.authenticated {
                AgentAuthSource::Cli
            } else {
                AgentAuthSource::None
            },
            detail: None,
        })
    }

    fn login_capabilities(&self) -> AgentAuthLoginCapabilities {
        let login = Rc::new(ClaudeLogin(self.login.clone()));
        AgentAuthLoginCapabilities {
            launch_login: Some(login.clone()),
            complete_login: Some(login.clone()),
            login_status: Some(login),
        }
    }
}

struct ClaudeLogin(CliLoginController);

#[async_trait(?Send)]
impl AgentAuthLaunchLogin for ClaudeLogin {
    async fn launch_login(&self) -> ExecutorResult<AgentAuthLoginLaunchResult> {
        self.0.launch().await
    }
}

#[async_trait(?Send)]
impl AgentAuthCompleteLogin for ClaudeLogin {
    async fn complete_login(
        &self,
        session_id: &str,
        code: &str,
    ) -> ExecutorResult<AgentAuthLoginCompleteResult> {
        self.0.complete(session_id, code).await
    }
}

#[async_trait(?Send)]
impl AgentAuthLoginStatusReader for ClaudeLogin {
    async fn login_status(
        &self,
        expected_session_id: Option<&str>,
    ) -> ExecutorResult<AgentAuthLoginStatus> {
        Ok(self.0.status(expected_session_id))
    }
}

#[async_trait(?Send)]
impl AgentCommands for ClaudeSlashCommandDiscovery {
    async fn discover(
        &self,
        project_path: &str,
        signal: CancellationToken,
    ) -> ExecutorResult<Vec<SlashCommand>> {
        check_signal(&signal)?;
        self.discover(project_path).await
    }
}

#[async_trait(?Send)]
impl RuntimeSteering for ClaudeCli {
    fn capture_target(&self, agent_session_id: &str) -> Option<RuntimeSteerTarget> {
        self.steering.capture_target(agent_session_id)
    }

    async fn steer(&self, request: RuntimeSteerRequest) -> ExecutorResult<AgentSteerResult> {
        self.steering.steer(request).await
    }
}

struct ClaudeConfigurationValidation;

#[async_trait(?Send)]
impl AgentConfigurationValidation for ClaudeConfigurationValidation {
    async fn validate(
        &self,
        configuration: AgentSessionConfiguration,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        resolve_claude_model(&configuration.model)?;
        Ok(())
    }
}

#[async_trait(?Send)]
impl AgentEndpoints for ClaudeConfigurationValidation {
    async fn validate(
        &self,
        selection: AgentEndpointSelection,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        if selection.protocol != ApiProtocol::AnthropicMessages {
            return Err(invalid_endpoint().into());
        }
        Ok(())
    }
}

struct ClaudeSingleQuery {
    config: ClaudeConfig,
    api_providers: Rc<dyn AgentApiProviderReader>,
    logger: Rc<dyn AgentLogger>,
    version_probe: Rc<crate::cli_version::ClaudeCliVersionProbe>,
}

#[async_trait(?Send)]
impl AgentSingleQuery for ClaudeSingleQuery {
    async fn run(&self, request: AgentSingleQueryRequest) -> ExecutorResult<String> {
        let endpoint = resolve_agent_endpoint(
            self.api_providers.as_ref(),
            request.endpoint.clone(),
            &request.signal,
        )
        .await?;
        let endpoint = endpoint
            .as_ref()
            .map(|endpoint| build_claude_endpoint_runtime(endpoint)?.ok_or_else(invalid_endpoint))
            .transpose()?;
        let runtime = single_query_runtime_options(&request);
        with_single_query_directory(&request.signal, |directory| async move {
            let mut environment = build_claude_host_environment(&self.config)?.unwrap_or_default();
            if let Some(endpoint) = endpoint {
                environment.extend(endpoint.env_overrides);
            }
            let config = self.config.clone();
            run_single_query(
                request.prompt,
                ClaudeSingleQueryOptions {
                    model: Some(request.model),
                    cwd: Some(directory.into()),
                    permission_mode: runtime.values.get("permissionMode").and_then(|value| {
                        garcon_contract::chat_modes::is_permission_mode(value.as_value())
                    }),
                    thinking_mode: Some(request.thinking_mode),
                    claude_thinking_mode: None,
                    env_overrides: os_environment(environment),
                    timeout_ms: runtime
                        .values
                        .get("timeoutMs")
                        .map(|value| value.as_value()),
                    signal: Some(runtime.signal),
                },
                Rc::new(move || config.binary().map(OsString::from)),
                self.logger.clone(),
                self.version_probe.clone(),
            )
            .await
        })
        .await
        .map_err(classify_claude_error)
    }

    fn runs_tools_without_permission(&self) -> bool {
        false
    }
}

fn classify_claude_error(error: Box<dyn std::error::Error>) -> Box<dyn std::error::Error> {
    if as_agent_integration_error(error.as_ref()).is_some() {
        return error;
    }
    let message = error.to_string();
    let normalized = message.to_lowercase();
    let code = if normalized.contains("auth") || normalized.contains("login") {
        AgentIntegrationErrorCode::AUTH_REQUIRED
    } else if normalized.contains("rate limit") || normalized.contains("429") {
        AgentIntegrationErrorCode::RATE_LIMITED
    } else if normalized.contains("timeout") || normalized.contains("timed out") {
        AgentIntegrationErrorCode::TIMEOUT
    } else {
        AgentIntegrationErrorCode::PROVIDER_FAILURE
    };
    AgentIntegrationError::new(
        code,
        message,
        code != AgentIntegrationErrorCode::AUTH_REQUIRED,
        None,
    )
    .into()
}

fn os_environment(
    values: impl IntoIterator<Item = (String, String)>,
) -> indexmap::IndexMap<OsString, OsString> {
    values
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect()
}

#[cfg(test)]
mod tests;
