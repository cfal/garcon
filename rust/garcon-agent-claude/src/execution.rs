use std::{cell::RefCell, rc::Rc};

use async_trait::async_trait;
use garcon_agents_common::{
    execution::{
        admission::assert_execution_open,
        resolve_endpoint::resolve_agent_endpoint,
        runtime_events::{
            AgentRuntimeEvent, AgentRuntimeExecution, AgentRuntimeExecutionContext,
            AgentRuntimePublisher, AgentRuntimeResumeRequest, AgentRuntimeStartRequest,
            runtime_operation,
        },
    },
    native_session::path_native_session::{PathNativeSessionCodec, PathNativeSessionValue},
};
use garcon_contract::{
    chat_modes::ClaudeThinkingMode, transcript_seed::receipt_for_carried_context,
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    execution::{
        AgentProjectPathUpdatePreparation, AgentProjectPathUpdateRequest, AgentRunningSession,
        AgentSessionConfiguration, AgentSessionConfigurationUpdate,
        AgentSessionConfigurationUpdates,
    },
    host::{AgentHost, AgentLogger},
    producer::AgentEstablishedSession,
    resources::{ExecutorCallOptions, ExecutorResult},
    transcript::AgentNativeSessionRef,
};
use garcon_js::{OptionalNullable, json::Opaque};
use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::{
    claude_cli::ClaudeCli,
    config::ClaudeConfig,
    endpoint_runtime::{build_claude_endpoint_runtime, build_claude_host_environment},
    model_context::resolve_claude_model,
    native_path::{
        ClaudeNativePathOptions, ClaudeNativeSessionRelocation, create_claude_native_path,
        prepare_claude_native_session_relocation,
    },
    runtime_types::{
        ClaudeExecutionRequest, ClaudeProjectPathUpdate, ClaudeResumeRequest, ClaudeStartRequest,
    },
};

pub struct ClaudeExecution {
    pub host: Rc<AgentHost>,
    pub runtime: Rc<ClaudeCli>,
    pub native_sessions: Rc<PathNativeSessionCodec>,
    pub logger: Rc<dyn AgentLogger>,
    pub config: ClaudeConfig,
    pub new_session_id: Rc<dyn Fn() -> String>,
}

#[async_trait(?Send)]
impl AgentRuntimeExecution for ClaudeExecution {
    async fn start(
        &self,
        request: AgentRuntimeStartRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<AgentEstablishedSession> {
        let AgentRuntimeStartRequest {
            context,
            prompt,
            attachments,
            carried_context,
        } = request;
        assert_execution_open(context.admission.as_ref())?;
        resolve_claude_model(&context.model)?;
        let env_overrides = self.endpoint_environment(&context).await?;
        let agent_session_id = (self.new_session_id)();
        let home_dir = system_home_dir();
        let native_path = create_claude_native_path(
            &context.project_path,
            &agent_session_id,
            &ClaudeNativePathOptions {
                home_dir: &home_dir,
                config_home_dir: env_overrides
                    .as_ref()
                    .and_then(|env| env.get("CLAUDE_CONFIG_DIR").map(String::as_str)),
                logger: Some(self.logger.clone()),
            },
        )
        .await;
        assert_execution_open(context.admission.as_ref())?;
        let established = AgentEstablishedSession {
            agent_session_id: agent_session_id.clone(),
            native_session: self.native_sessions.encode(PathNativeSessionValue {
                path: native_path,
                agent_session_id: Some(agent_session_id.clone()),
                model_endpoint_id: context
                    .endpoint
                    .as_ref()
                    .map(|endpoint| endpoint.endpoint_id.clone()),
            }),
            native_seed_receipt: receipt_for_carried_context(
                carried_context.as_ref(),
                &agent_session_id,
                None,
            )?,
        };
        let command = match carried_context {
            Some(carried) => carried.prefix + &prompt,
            None => prompt,
        };
        let (activated, activation) = oneshot::channel::<ExecutorResult<()>>();
        let activated = Rc::new(RefCell::new(Some(activated)));
        let execution = execution_fields(
            context,
            command,
            attachments,
            env_overrides,
            publish.clone(),
        );
        let operation = execution.operation.clone();
        let chat_id = execution.chat_id.clone();
        let on_session_activated = {
            let activated = activated.clone();
            let established = established.clone();
            Rc::new(move || {
                publish(AgentRuntimeEvent::Session {
                    session: established.clone(),
                });
                if let Some(activated) = activated.take() {
                    let _ = activated.send(Ok(()));
                }
            })
        };
        let request = ClaudeStartRequest {
            execution,
            agent_session_id: agent_session_id.clone(),
            on_session_activated: Some(on_session_activated),
        };
        let runtime = self.runtime.clone();
        let logger = self.logger.clone();
        tokio::task::spawn_local(async move {
            if let Err(error) = runtime.start_claude_cli_session(request).await {
                let message = error.to_string();
                let fields: IndexMap<String, Opaque> = IndexMap::from([
                    ("chatId".into(), json!(chat_id).into()),
                    ("error".into(), json!(message).into()),
                ]);
                logger.error("Claude session start failed", Some(&fields));
                runtime.fail_claude_internal_session(&agent_session_id, message, operation);
                if let Some(activated) = activated.take() {
                    let _ = activated.send(Err(error));
                }
            }
        });
        activation.await??;
        Ok(established)
    }

    async fn resume(
        &self,
        request: AgentRuntimeResumeRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<()> {
        resolve_claude_model(&request.context.model)?;
        let native_path = self
            .native_sessions
            .decode(request.native_session.as_ref())?
            .path;
        let env_overrides = self.endpoint_environment(&request.context).await?;
        self.runtime
            .run_claude_turn(ClaudeResumeRequest {
                execution: execution_fields(
                    request.context,
                    request.prompt,
                    request.attachments,
                    env_overrides,
                    publish,
                ),
                agent_session_id: request.agent_session_id,
                native_path,
            })
            .await
    }

    async fn abort(&self, agent_session_id: &str) -> ExecutorResult<bool> {
        self.runtime.abort_session(agent_session_id).await
    }

    fn running_sessions(&self) -> Vec<AgentRunningSession> {
        self.runtime.running_sessions()
    }
}

#[async_trait(?Send)]
impl AgentSessionConfigurationUpdates for ClaudeExecution {
    async fn apply(
        &self,
        agent_session_id: &str,
        update: AgentSessionConfigurationUpdate,
        _previous: AgentSessionConfiguration,
        _options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        let AgentSessionConfiguration {
            permission_mode,
            thinking_mode,
            settings,
            ..
        } = update.configuration;
        self.runtime
            .set_internal_permission_mode(agent_session_id, permission_mode);
        self.runtime
            .set_internal_thinking_mode(agent_session_id, thinking_mode);
        self.runtime.set_internal_claude_thinking_mode(
            agent_session_id,
            claude_thinking_mode(&settings.values["claudeThinkingMode"]),
        );
        Ok(())
    }
}

impl ClaudeExecution {
    async fn endpoint_environment(
        &self,
        context: &AgentRuntimeExecutionContext,
    ) -> ExecutorResult<Option<IndexMap<String, String>>> {
        let endpoint = resolve_agent_endpoint(
            self.host.api_providers.as_ref(),
            context.endpoint.clone(),
            context.admission.signal(),
        )
        .await?;
        let mut environment = build_claude_host_environment(&self.config)?;
        if let Some(endpoint) = endpoint {
            let runtime = build_claude_endpoint_runtime(&endpoint)?.ok_or_else(invalid_endpoint)?;
            environment
                .get_or_insert_with(IndexMap::new)
                .extend(runtime.env_overrides);
        }
        Ok(environment)
    }

    pub async fn prepare_project_path_update(
        &self,
        request: AgentProjectPathUpdateRequest,
    ) -> ExecutorResult<Option<Rc<dyn AgentProjectPathUpdatePreparation>>> {
        check_signal(&request.signal)?;
        let Some(agent_session_id) = request.chat.agent_session_id.filter(|id| !id.is_empty())
        else {
            return Ok(None);
        };
        let native = self
            .native_sessions
            .decode(request.chat.native_session.as_ref())?;
        self.runtime
            .prepare_claude_project_path_update(ClaudeProjectPathUpdate {
                chat_id: request.chat.chat_id,
                agent_session_id: Some(agent_session_id.clone()),
                previous_project_path: request.chat.project_path.clone(),
                next_project_path: request.next_project_path.clone(),
                native_path: native.path.clone(),
            })
            .await?;
        check_signal(&request.signal)?;
        let home_dir = system_home_dir();
        let config_home_dir = self.config.config_home_dir()?;
        let relocation = prepare_claude_native_session_relocation(
            &request.chat.project_path,
            &request.next_project_path,
            &agent_session_id,
            native.path.as_deref(),
            &ClaudeNativePathOptions {
                home_dir: &home_dir,
                config_home_dir: config_home_dir.as_deref(),
                logger: Some(self.logger.clone()),
            },
        )
        .await?;
        let native_session = self.native_sessions.encode(PathNativeSessionValue {
            path: Some(relocation.native_path.clone()),
            agent_session_id: Some(agent_session_id),
            model_endpoint_id: native.model_endpoint_id,
        });
        Ok(Some(Rc::new(Relocation {
            native_session,
            relocation,
        })))
    }
}

struct Relocation {
    native_session: Option<AgentNativeSessionRef>,
    relocation: ClaudeNativeSessionRelocation,
}

#[async_trait(?Send)]
impl AgentProjectPathUpdatePreparation for Relocation {
    fn native_session(&self) -> OptionalNullable<&AgentNativeSessionRef> {
        OptionalNullable::from(self.native_session.as_ref())
    }

    async fn commit(&self) -> ExecutorResult<()> {
        self.relocation.commit().await?;
        Ok(())
    }

    async fn rollback(&self) -> ExecutorResult<()> {
        self.relocation.rollback().await?;
        Ok(())
    }
}

fn execution_fields(
    context: AgentRuntimeExecutionContext,
    command: String,
    images: Vec<garcon_contract::agent_execution::AgentAttachment>,
    env_overrides: Option<IndexMap<String, String>>,
    publish: AgentRuntimePublisher,
) -> ClaudeExecutionRequest {
    ClaudeExecutionRequest {
        chat_id: context.chat_id,
        project_path: context.project_path,
        model: context.model,
        permission_mode: context.permission_mode,
        thinking_mode: context.thinking_mode,
        claude_thinking_mode: Some(claude_thinking_mode(
            &context.settings.values["claudeThinkingMode"],
        )),
        execution_admission: Some(context.admission),
        command,
        images,
        env_overrides,
        operation: runtime_operation(context.run_id, publish),
    }
}

fn claude_thinking_mode(value: &Value) -> ClaudeThinkingMode {
    match value.as_str() {
        Some("on") => ClaudeThinkingMode::On,
        Some("off") => ClaudeThinkingMode::Off,
        _ => ClaudeThinkingMode::Auto,
    }
}

pub(crate) fn invalid_endpoint() -> AgentIntegrationError {
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::INVALID_ENDPOINT,
        "Claude requires an Anthropic Messages endpoint",
        false,
        None,
    )
}

pub(crate) fn check_signal(signal: &tokio_util::sync::CancellationToken) -> ExecutorResult<()> {
    if signal.is_cancelled() {
        return Err(garcon_base::errors::NamedError {
            name: "AbortError".into(),
            message: "The operation was aborted.".into(),
            code: None,
        }
        .into());
    }
    Ok(())
}

pub(crate) fn system_home_dir() -> String {
    std::env::home_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use garcon_agents_common::{
        direct::conformance_host::conformance_host, execution::runtime_events::ProviderRunOutcome,
    };
    use garcon_contract::{
        agent_execution::AgentEndpointSelection,
        agent_integration::AgentSettingsEnvelope,
        api_providers::ApiProtocol,
        chat_modes::{PermissionMode, ThinkingMode},
        transcript_seed::CarriedContext,
    };
    use garcon_interface::{execution::AgentExecutionAdmission, host::AgentEnvironmentReader};
    use tokio::{sync::mpsc, task::LocalSet};
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::config::create_claude_config;

    struct Environment(String);

    impl AgentEnvironmentReader for Environment {
        fn get(&self, name: &str) -> ExecutorResult<Option<String>> {
            Ok((name == "CLAUDE_CONFIG_DIR").then(|| self.0.clone()))
        }
    }

    struct Admission(CancellationToken);

    #[async_trait(?Send)]
    impl AgentExecutionAdmission for Admission {
        fn signal(&self) -> &CancellationToken {
            &self.0
        }

        async fn mark_started(&self) -> ExecutorResult<()> {
            panic!("provider must not run a prompt")
        }
    }

    fn fixture(root: &std::path::Path) -> (ClaudeExecution, AgentRuntimeStartRequest) {
        let mut host = conformance_host("claude", root).unwrap();
        let config_home = root.join("config").to_string_lossy().into_owned();
        host.environment = Rc::new(Environment(config_home));
        let config = create_claude_config(host.environment.clone());
        let logger = host.logger.clone();
        let runtime = ClaudeCli::with_executable_reader(
            Rc::new(|| Err("synthetic executable read failure".into())),
            logger.clone(),
        );
        let provider = ClaudeExecution {
            host: Rc::new(host),
            runtime,
            native_sessions: Rc::new(PathNativeSessionCodec::new("claude")),
            logger,
            config,
            new_session_id: Rc::new(|| "synthetic-native-id".into()),
        };
        let request = AgentRuntimeStartRequest {
            context: AgentRuntimeExecutionContext {
                chat_id: "synthetic-chat".into(),
                project_path: root.to_string_lossy().into_owned(),
                model: "sonnet".into(),
                permission_mode: PermissionMode::Default,
                thinking_mode: ThinkingMode::None,
                settings: AgentSettingsEnvelope {
                    owner_id: "claude".into(),
                    schema_version: 1,
                    values: json!({"claudeThinkingMode":"auto"}).into(),
                },
                endpoint: None,
                run_id: "synthetic-run".into(),
                submission: None,
                admission: Rc::new(Admission(CancellationToken::new())),
            },
            prompt: "synthetic prompt".into(),
            attachments: Vec::new(),
            carried_context: Some(CarriedContext {
                prefix: "synthetic carried context\n".into(),
                summary_truncated: None,
            }),
        };
        (provider, request)
    }

    #[tokio::test]
    async fn publishes_the_native_binding_and_receipt_before_a_late_start_failure() {
        LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let (provider, request) = fixture(root.path());
                let expected_receipt = receipt_for_carried_context(
                    request.carried_context.as_ref(),
                    "synthetic-native-id",
                    None,
                )
                .unwrap();
                let (publish, mut events) = mpsc::unbounded_channel();
                let established = provider
                    .start(request, Rc::new(move |event| publish.send(event).unwrap()))
                    .await
                    .unwrap();
                let AgentRuntimeEvent::Session { session } = events.recv().await.unwrap() else {
                    panic!("expected binding before failure");
                };
                assert_eq!(session, established);
                assert_eq!(established.native_seed_receipt, expected_receipt);
                let native = provider
                    .native_sessions
                    .decode(session.native_session.as_ref())
                    .unwrap();
                assert_eq!(
                    native.agent_session_id.as_deref(),
                    Some("synthetic-native-id")
                );
                assert!(
                    std::path::Path::new(native.path.as_deref().unwrap())
                        .starts_with(root.path().join("config").join("projects"))
                );
                let AgentRuntimeEvent::RunEnded {
                    run_id,
                    outcome: ProviderRunOutcome::Failed { error: Some(error) },
                    ..
                } = events.recv().await.unwrap()
                else {
                    panic!("expected failed run after publication");
                };
                assert_eq!(run_id, "synthetic-run");
                assert_eq!(error.code, "PROVIDER_FAILURE");
                assert_eq!(
                    error.message.as_deref(),
                    Some("synthetic executable read failure")
                );
                assert!(provider.running_sessions().is_empty());
            })
            .await;
    }

    #[tokio::test]
    async fn refuses_non_anthropic_endpoints_before_creating_the_native_binding() {
        let root = tempfile::tempdir().unwrap();
        let (provider, mut request) = fixture(root.path());
        request.context.endpoint = Some(AgentEndpointSelection {
            api_provider_id: "synthetic-provider".into(),
            endpoint_id: "synthetic-endpoint".into(),
            provider_label: "Synthetic".into(),
            protocol: ApiProtocol::OpenAiCompatible,
            base_url: "https://synthetic.invalid".into(),
            model: "synthetic-model".into(),
            is_local: false,
            capabilities: None,
            headers: IndexMap::new(),
            credential: None,
        });
        let error = provider
            .start(request, Rc::new(|_| panic!("unexpected publication")))
            .await
            .unwrap_err();
        let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
        assert_eq!(error.code, AgentIntegrationErrorCode::INVALID_ENDPOINT);
        assert_eq!(
            error.message,
            "Claude requires an Anthropic Messages endpoint"
        );
        assert!(!error.retryable);
        assert!(provider.running_sessions().is_empty());
    }
}
