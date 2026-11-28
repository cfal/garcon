//! Ports `agents/antigravity/run-single-query.ts`.

use std::{rc::Rc, time::Duration};

use async_trait::async_trait;
use garcon_agents_common::{
    acp::{
        policy::explicit_acp_model,
        protocol::garcon_initialize_params,
        single_query::{AcpSingleQueryOptions, run_acp_single_query},
        transport::{AcpSpawnSpec, AcpTransport},
    },
    shared::shared_probe::wait_unless_aborted,
};
use garcon_contract::chat_modes::ThinkingMode;
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    resources::ExecutorResult,
    services::{AgentSingleQuery, AgentSingleQueryRequest},
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    antigravity_acp_event_converter::split_executor_error,
    antigravity_acp_policy::{apply_mode, apply_model},
    antigravity_auth::check_signal,
    config::{AntigravityConfig, child_environment, integration_error},
};

pub struct AntigravitySingleQueryOptions {
    pub project_path: String,
    pub model: Option<String>,
    pub thinking_mode: ThinkingMode,
    pub timeout_ms: Option<f64>,
    pub signal: CancellationToken,
    pub create_transport: Option<Rc<dyn Fn() -> AcpTransport>>,
}

pub async fn run_antigravity_single_query(
    prompt: String,
    options: AntigravitySingleQueryOptions,
    config: &AntigravityConfig,
) -> ExecutorResult<String> {
    if options.thinking_mode != ThinkingMode::None {
        return Err(AgentIntegrationError::new(
            Code::OPERATION_UNSUPPORTED,
            format!(
                "antigravity does not support explicit one-shot effort {}.",
                options.thinking_mode.as_str()
            ),
            false,
            Some(
                [
                    ("operation".into(), json!("single-query")),
                    ("setting".into(), json!("thinkingMode")),
                ]
                .into_iter()
                .collect(),
            ),
        )
        .into());
    }
    check_signal(&options.signal)?;
    let run = async {
        run_acp_single_query(AcpSingleQueryOptions {
            spawn: AcpSpawnSpec {
                command: config.binary()?,
                args: vec!["acp".into()],
                cwd: options.project_path,
                env: child_environment(config, &Default::default())?,
            },
            initialize: garcon_initialize_params(None)?,
            authenticate_method_id: Some(config.auth_method()?.into()),
            prompt,
            signal: options.signal.clone(),
            request_timeout_ms: options.timeout_ms,
            create_transport: options.create_transport,
            configure: Some(Rc::new(move |client, created| {
                let model = options.model.clone();
                Box::pin(async move {
                    if created.is_null() {
                        return Err(garcon_base::errors::NamedError {
                            name: "TypeError".into(),
                            message: "null is not an object (evaluating 'created.sessionId')"
                                .into(),
                            code: None,
                        }
                        .into());
                    }
                    let id = created
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            integration_error(
                                Code::PROVIDER_FAILURE,
                                "ACP session response did not include a string sessionId",
                            )
                        })?;
                    apply_model(
                        &client,
                        id,
                        created.get("models"),
                        explicit_acp_model(model.as_deref()),
                    )
                    .await?;
                    apply_mode(&client, id, created.get("configOptions"), "plan").await?;
                    Ok(())
                })
            })),
            respond_to_request: None,
            split_failure: Some(Rc::new(split_executor_error)),
        })
        .await
    };
    let operation = wait_unless_aborted(run, Some(&options.signal));
    if let Some(ms) = options.timeout_ms.filter(|ms| ms.is_finite() && *ms > 0.0) {
        let ms = ms.round().max(1.0);
        let delay = if ms <= f64::from(i32::MAX) {
            ms as u64
        } else {
            1
        };
        return tokio::time::timeout(Duration::from_millis(delay), operation)
            .await
            .map_err(|_| {
                AgentIntegrationError::new(
                    Code::TIMEOUT,
                    format!("Single query timed out after {ms}ms."),
                    true,
                    None,
                )
            })?;
    }
    operation.await
}

pub(crate) struct AntigravitySingleQuery(pub AntigravityConfig);

#[async_trait(?Send)]
impl AgentSingleQuery for AntigravitySingleQuery {
    async fn run(&self, request: AgentSingleQueryRequest) -> ExecutorResult<String> {
        check_signal(&request.signal)?;
        let result: ExecutorResult<String> = async {
            let directory = tokio::task::spawn_blocking(|| {
                tempfile::Builder::new()
                    .prefix("garcon-single-query-")
                    .tempdir()
            })
            .await??;
            let result = run_antigravity_single_query(
                request.prompt,
                AntigravitySingleQueryOptions {
                    project_path: directory.path().to_string_lossy().into_owned(),
                    model: Some(request.model),
                    thinking_mode: request.thinking_mode,
                    timeout_ms: request.timeout_ms.map(|number| number.0).or_else(|| {
                        request
                            .settings
                            .values
                            .get("timeoutMs")
                            .and_then(Value::as_f64)
                    }),
                    signal: request.signal,
                    create_transport: None,
                },
                &self.0,
            )
            .await;
            tokio::task::spawn_blocking(move || directory.close()).await??;
            result
        }
        .await;
        result.map_err(|error| {
            if error.is::<AgentIntegrationError>() {
                error
            } else {
                integration_error(Code::PROVIDER_FAILURE, error.to_string())
            }
        })
    }

    fn runs_tools_without_permission(&self) -> bool {
        false
    }
}
