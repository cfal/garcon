use garcon_agents_common::shared::single_query_control::{
    SingleQueryControlOptions, run_isolated_single_query, single_query_runtime_options,
    with_single_query_control,
};
use garcon_contract::chat_modes::ThinkingMode;
use garcon_interface::services::AgentSingleQueryRequest;

use super::{
    super::{
        permissions::map_permission_mode,
        prompt::parse_open_code_model,
        sdk_result::{create_open_code_request_scope, throw_open_code_result_error},
        sse_events::extract_text_parts,
    },
    sessions::session_params,
    turns::created_session_id,
    *,
};
use crate::js::prop;

pub(super) struct OpenCodeSingleQueryRequest {
    pub prompt: String,
    pub project_path: String,
    pub model: String,
    pub permission_mode: String,
    pub thinking_mode: ThinkingMode,
    pub timeout_ms: Option<f64>,
    pub signal: AbortSignal,
}

impl OpenCodeRuntime {
    pub(crate) async fn run_isolated_query(
        self: &Rc<Self>,
        request: AgentSingleQueryRequest,
    ) -> ExecutorResult<String> {
        let options = single_query_runtime_options(&request);
        let timeout_ms = options.values.get("timeoutMs").map(Opaque::as_value);
        let permission_mode = options
            .values
            .get("permissionMode")
            .and_then(|mode| mode.as_str())
            .unwrap_or("default")
            .to_owned();
        run_isolated_single_query(&request, |project_path| async {
            with_single_query_control(
                SingleQueryControlOptions {
                    signal: Some(options.signal),
                    timeout_ms,
                },
                |signal| {
                    let runtime = self.clone();
                    let query = OpenCodeSingleQueryRequest {
                        project_path,
                        prompt: request.prompt.clone(),
                        model: request.model.clone(),
                        permission_mode,
                        thinking_mode: request.thinking_mode,
                        timeout_ms: timeout_ms.and_then(garcon_js::json::as_number),
                        signal: AbortSignal::from_token(signal),
                    };
                    // The shared control can stop waiting before the provider
                    // unwinds. Keep native session deletion alive in that case.
                    let work = spawn_local(async move { runtime.run_single_query(query).await });
                    async move { work.await? }
                },
            )
            .await
        })
        .await
    }

    pub(super) async fn run_single_query(
        self: &Rc<Self>,
        request: OpenCodeSingleQueryRequest,
    ) -> ExecutorResult<String> {
        let signal = request.signal.clone();
        self.with_client_lease(
            |client| async move {
                let scope = create_open_code_request_scope(Some(&request.project_path));
                let generation = self.generation.get();
                let assert_current = || {
                    if generation == self.generation.get()
                        && self
                            .get_client_if_initialized()
                            .is_some_and(|current| Rc::ptr_eq(&client, &current))
                    {
                        Ok(())
                    } else {
                        Err(error(
                            "Error",
                            "OpenCode server process was retired while the request was in flight",
                        ))
                    }
                };
                assert_current()?;
                let control = OpenCodeRequestControl {
                    signal: Some(request.signal),
                    timeout: request
                        .timeout_ms
                        .filter(|value| value.is_finite())
                        .map(|ms| OpenCodeRequestTimeout::After(garcon_js::math_round(ms).max(1.0)))
                        .unwrap_or_default(),
                };
                let result = self
                    .scoped_request(
                        "OpenCode session create",
                        client.clone(),
                        OpenCodeRequest::SessionCreate,
                        Map::from_iter([(
                            "permission".to_owned(),
                            json!(map_permission_mode(&request.permission_mode)),
                        )]),
                        &scope,
                        control.clone(),
                    )
                    .await?;
                let id = created_session_id(&result)?;
                let reply = async {
                    assert_current()?;
                    let model = parse_open_code_model(Some(&request.model));
                    let mut params = session_params(&id);
                    params.insert(
                        "parts".to_owned(),
                        json!([{"type": "text", "text": request.prompt}]),
                    );
                    params.insert("tools".to_owned(), json!({"*": false}));
                    if let Some(model) = model {
                        params.insert(
                            "model".to_owned(),
                            json!({"providerID": model.provider_id, "modelID": model.model_id}),
                        );
                    }
                    let variant = self
                        .models
                        .resolve_thinking_variant_for_turn(
                            Some(&request.model),
                            Some(request.thinking_mode),
                        )
                        .await;
                    assert_current()?;
                    if let Some(variant) = variant {
                        params.insert("variant".to_owned(), json!(variant));
                    }
                    let result = self
                        .scoped_request(
                            "OpenCode prompt",
                            client.clone(),
                            OpenCodeRequest::SessionPrompt,
                            params,
                            &scope,
                            control,
                        )
                        .await?;
                    assert_current()?;
                    throw_open_code_result_error(&result, "OpenCode one-shot prompt failed")?;
                    Ok(extract_text_parts(prop(prop(&*result, "data"), "parts")))
                }
                .await;
                self.delete_session_best_effort(id, scope, Some((client, Some(generation))))
                    .await;
                reply
            },
            Some(signal),
        )
        .await
    }
}
