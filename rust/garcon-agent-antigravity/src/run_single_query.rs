//! Ports `agents/antigravity/run-single-query.ts`.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_agents_common::{
    acp::{
        policy::explicit_acp_model,
        protocol::garcon_initialize_params,
        single_query::{AcpSingleQueryOptions, run_acp_single_query},
        transport::{AcpSpawnSpec, AcpTransport},
    },
    shared::single_query_control::{
        SingleQueryControlOptions, run_isolated_single_query, single_query_runtime_options,
        with_single_query_control,
    },
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
    let timeout = options.timeout_ms.map(Value::from);
    with_single_query_control(
        SingleQueryControlOptions {
            signal: Some(options.signal),
            timeout_ms: timeout.as_ref(),
        },
        |signal| async move {
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
                signal,
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
        },
    )
    .await
}

pub(crate) struct AntigravitySingleQuery(pub AntigravityConfig);

#[async_trait(?Send)]
impl AgentSingleQuery for AntigravitySingleQuery {
    async fn run(&self, request: AgentSingleQueryRequest) -> ExecutorResult<String> {
        run_isolated_single_query(&request, |directory| {
            let runtime = single_query_runtime_options(&request);
            run_antigravity_single_query(
                request.prompt.clone(),
                AntigravitySingleQueryOptions {
                    project_path: directory,
                    model: Some(request.model.clone()),
                    thinking_mode: request.thinking_mode,
                    timeout_ms: runtime
                        .values
                        .get("timeoutMs")
                        .and_then(|value| value.as_f64()),
                    signal: runtime.signal,
                    create_transport: None,
                },
                &self.0,
            )
        })
        .await
    }

    fn runs_tools_without_permission(&self) -> bool {
        false
    }
}
