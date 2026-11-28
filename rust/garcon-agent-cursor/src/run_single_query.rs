//! Ports `agents/cursor/run-single-query.ts`.

use std::rc::Rc;

use garcon_agents_common::{
    acp::{
        protocol::garcon_initialize_params,
        single_query::{AcpSingleQueryOptions, run_acp_single_query},
        transport::{AcpSpawnSpec, AcpTransport},
    },
    shared::single_query_control::{
        SingleQueryControlOptions, SingleQueryRuntimeOptions, with_single_query_control,
    },
};
use garcon_contract::chat_modes::ThinkingMode;
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    resources::ExecutorResult,
};
use serde_json::{Value, json};

use crate::{
    config::CursorConfig,
    cursor_acp_model_config::configure_cursor_acp_session_options,
    cursor_acp_policy::{CURSOR_AUTH_METHOD, cursor_capabilities, cursor_child_env},
};

pub async fn run_single_query(
    prompt: String,
    raw: SingleQueryRuntimeOptions,
    thinking_mode: ThinkingMode,
    config: &CursorConfig,
    create_transport: Option<Rc<dyn Fn() -> AcpTransport>>,
) -> ExecutorResult<String> {
    if thinking_mode != ThinkingMode::None {
        return Err(AgentIntegrationError::new(
            Code::OPERATION_UNSUPPORTED,
            format!(
                "cursor does not support explicit one-shot effort {}.",
                thinking_mode.as_str()
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
    let timeout = raw
        .values
        .get("timeoutMs")
        .map(garcon_js::json::Opaque::as_value);
    with_single_query_control(
        SingleQueryControlOptions {
            signal: Some(raw.signal),
            timeout_ms: timeout,
        },
        |signal| async {
            let string = |name| raw.values.get(name).and_then(|value| value.as_str());
            let cwd = ["cwd", "projectPath"]
                .into_iter()
                .filter_map(string)
                .find(|value| !value.is_empty())
                .map(str::to_owned)
                .map_or_else(
                    || std::env::current_dir().map(|path| path.to_string_lossy().into_owned()),
                    Ok,
                )?;
            let overrides = raw
                .values
                .get("envOverrides")
                .and_then(|value| value.as_object())
                .into_iter()
                .flat_map(|entry| entry.iter())
                .filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_owned())))
                .collect();
            let timeout_ms = timeout
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .map(|number| garcon_js::math_round(number).max(1.0));
            let model = string("model").unwrap_or("default").to_owned();
            run_acp_single_query(AcpSingleQueryOptions {
                spawn: AcpSpawnSpec {
                    command: config.binary()?,
                    args: vec!["acp".into()],
                    cwd,
                    env: cursor_child_env(config, overrides)?,
                },
                initialize: garcon_initialize_params(Some(
                    &json!({"clientCapabilities":cursor_capabilities(),"mcpServers":[]}),
                ))?,
                authenticate_method_id: Some(CURSOR_AUTH_METHOD.into()),
                prompt,
                signal,
                request_timeout_ms: timeout_ms,
                create_transport,
                configure: Some(Rc::new(move |client, created| {
                    let model = model.clone();
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
                                AgentIntegrationError::new(
                                    Code::PROVIDER_FAILURE,
                                    "ACP session response did not include a string sessionId",
                                    false,
                                    None,
                                )
                            })?;
                        configure_cursor_acp_session_options(
                            &client,
                            id,
                            &model,
                            "ask",
                            created.get("configOptions").cloned(),
                            None,
                        )
                        .await?;
                        Ok(())
                    })
                })),
                respond_to_request: Some(Rc::new(|method| match method {
                    "cursor/ask_question" => Some(
                        json!({"outcome":{"outcome":"skipped","reason":"Noninteractive query"}}),
                    ),
                    "cursor/create_plan" => Some(
                        json!({"outcome":{"outcome":"rejected","reason":"Noninteractive query"}}),
                    ),
                    _ => None,
                })),
                split_failure: None,
            })
            .await
        },
    )
    .await
}
