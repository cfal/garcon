//! Ports `server/runtime/providers/discovery.ts`.

use std::collections::HashSet;
use std::time::Duration;

use garcon_agents_common::shared::{
    json_response::read_json_response,
    provider_http::{Method, header, send, sensitive_header},
};
use garcon_base::{errors::NamedError, provider_discovery::MODEL_DISCOVERY_TIMEOUT_MS};
use garcon_contract::{
    agents::AgentModelOption,
    api_providers::{ApiProviderModelDiscoveryResponse, ModelDiscoveryKind},
};
use garcon_interface::{
    execution_runtime::ApiProviderDiscoveryRequest,
    resources::{ExecutorCallOptions, ExecutorResult},
};
use garcon_js::{number_to_string, trim};
use serde_json::Value;
use url::Url;

fn model(value: &str, label: &str, is_local: Option<bool>) -> AgentModelOption {
    AgentModelOption {
        value: value.to_owned(),
        label: label.to_owned(),
        supports_images: None,
        thinking_modes: None,
        is_local,
        api_provider_id: None,
        endpoint_id: None,
        raw_model: None,
        protocol: None,
    }
}

fn dedupe(models: Vec<AgentModelOption>) -> Vec<AgentModelOption> {
    let mut seen = HashSet::new();
    models
        .into_iter()
        .filter(|model| !model.value.is_empty() && seen.insert(model.value.clone()))
        .collect()
}

fn open_ai_models(body: &Value) -> Vec<AgentModelOption> {
    let entries = body.as_array().or_else(|| body["data"].as_array());
    entries
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = trim(entry["id"].as_str()?);
            let label = ["display_name", "name"]
                .into_iter()
                .filter_map(|key| entry[key].as_str().map(trim))
                .find(|text| !text.is_empty())
                .unwrap_or(id);
            (!id.is_empty()).then(|| model(id, label, None))
        })
        .collect()
}

fn key(request: &ApiProviderDiscoveryRequest) -> Option<&str> {
    request.api_key.as_deref().filter(|key| !key.is_empty())
}

async fn get_json(url: &str, headers: header::HeaderMap, label: &str) -> ExecutorResult<Value> {
    let response = send(Method::GET, url, headers, None).await?;
    if !response.status().is_success() {
        return Err(format!("{label} failed with HTTP {}.", response.status().as_u16()).into());
    }
    read_json_response(response, "Model discovery").await
}

fn parse_url(url: &str) -> ExecutorResult<Url> {
    Url::parse(url).map_err(|_| "Invalid URL".into())
}

async fn anthropic_models(
    request: &ApiProviderDiscoveryRequest,
) -> ExecutorResult<Vec<AgentModelOption>> {
    let mut headers = header::HeaderMap::new();
    if let Some(key) = key(request) {
        headers.insert("x-api-key", sensitive_header(key)?);
    }
    headers.insert(
        "anthropic-version",
        header::HeaderValue::from_static("2023-06-01"),
    );
    let base = request.base_url.trim_end_matches('/');
    let suffix = if base.ends_with("/v1") {
        "models"
    } else {
        "v1/models"
    };
    let base = parse_url(&format!("{base}/{suffix}"))?;
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..5 {
        let mut url = base.clone();
        url.query_pairs_mut().append_pair("limit", "1000");
        if let Some(cursor) = &cursor {
            url.query_pairs_mut().append_pair("after_id", cursor);
        }
        let body = get_json(url.as_str(), headers.clone(), "Model discovery").await?;
        if body.is_null() {
            return Err("null is not an object (evaluating 'body.data')".into());
        }
        let entries = &body["data"];
        if !entries.is_array() && !entries.is_null() && !entries.is_string() {
            let value = if entries.is_object() {
                "{}".into()
            } else {
                entries.to_string()
            };
            return Err(format!("{value} is not iterable").into());
        }
        for entry in entries.as_array().into_iter().flatten() {
            if entry.is_null() {
                return Err("null is not an object (evaluating 'model.id')".into());
            }
            let Some(id) = entry["id"].as_str().filter(|id| !id.is_empty()) else {
                continue;
            };
            let label = ["display_name", "name"]
                .into_iter()
                .filter_map(|key| entry[key].as_str())
                .find(|text| !text.is_empty())
                .unwrap_or(id);
            models.push(model(id, label, None));
        }
        if body["has_more"].as_bool() != Some(true) {
            break;
        }
        let Some(last) = body["last_id"].as_str().filter(|text| !text.is_empty()) else {
            break;
        };
        if cursor.as_deref() == Some(last) {
            break;
        }
        cursor = Some(last.to_owned());
    }
    Ok(models)
}

async fn discover(request: ApiProviderDiscoveryRequest) -> ExecutorResult<Vec<AgentModelOption>> {
    let base = request.base_url.trim_end_matches('/');
    match request.model_discovery {
        ModelDiscoveryKind::None => Ok(Vec::new()),
        ModelDiscoveryKind::AnthropicModels => anthropic_models(&request).await,
        ModelDiscoveryKind::OllamaTags => {
            let url = format!("{}/api/tags", base.strip_suffix("/v1").unwrap_or(base));
            let url = Url::parse(&url).map_err(|_| "fetch() URL is invalid")?;
            let body = get_json(
                url.as_str(),
                header::HeaderMap::new(),
                "Ollama model discovery",
            )
            .await?;
            if body.is_null() {
                return Err("null is not an object (evaluating '(await readJsonResponse(response, \"Model discovery\")).models')".into());
            }
            let entries = &body["models"];
            if !entries.is_array() && !entries.is_null() {
                return Err(concat!(
                    "((await readJsonResponse(response, \"Model discovery\")).models ?? []).filter is not a function. ",
                    "(In '((await readJsonResponse(response, \"Model discovery\")).models ?? []).filter((model) => ",
                    "typeof model.name === \"string\" && model.name.length > 0)', ",
                    "'((await readJsonResponse(response, \"Model discovery\")).models ?? []).filter' is undefined)"
                ).into());
            }
            entries
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    if entry.is_null() {
                        return Some(Err("null is not an object (evaluating 'model.name')".into()));
                    }
                    let name = entry["name"].as_str().filter(|name| !name.is_empty())?;
                    Some(Ok(model(name, &format!("{name} (local)"), Some(true))))
                })
                .collect()
        }
        ModelDiscoveryKind::OpenAiModels | ModelDiscoveryKind::OpenRouterModels => {
            let url = parse_url(base)?;
            let suffix = if url.path().trim_end_matches('/').is_empty() {
                "v1/models"
            } else {
                "models"
            };
            let mut headers = header::HeaderMap::new();
            if let Some(key) = key(&request) {
                headers.insert(
                    header::AUTHORIZATION,
                    sensitive_header(&format!("Bearer {key}"))?,
                );
            }
            Ok(open_ai_models(
                &get_json(&format!("{base}/{suffix}"), headers, "Model discovery").await?,
            ))
        }
    }
}

pub async fn discover_api_provider_models(
    request: ApiProviderDiscoveryRequest,
    options: Option<ExecutorCallOptions>,
) -> ExecutorResult<ApiProviderModelDiscoveryResponse> {
    let options = options.unwrap_or_default();
    let timeout_ms = options
        .timeout_ms
        .unwrap_or(MODEL_DISCOVERY_TIMEOUT_MS as f64);
    const MAX_DELAY: f64 = 9_007_199_254_740_991.0;
    let delay = timeout_ms.trunc();
    if !(0.0..=MAX_DELAY).contains(&delay) {
        return Err(NamedError {
            name: "TypeError".into(),
            message: format!(
                "Value {} is outside the range [0, 9007199254740991]",
                number_to_string(timeout_ms)
            ),
            code: None,
        }
        .into());
    }
    let timeout = Duration::from_millis(delay as u64);
    let signal = options.signal.unwrap_or_default();
    let elapsed = tokio::time::sleep(timeout);
    let result = tokio::select! {
        biased;
        () = signal.cancelled() => Err("The operation was aborted.".into()),
        () = async {
            // Bun arms a zero timeout without aborting synchronous discovery work.
            if timeout.is_zero() {
                tokio::task::yield_now().await;
            }
            elapsed.await;
        } => Err("The operation timed out.".into()),
        result = discover(request) => result,
    };
    match result {
        Ok(models) => Ok(ApiProviderModelDiscoveryResponse {
            success: true,
            models: (!models.is_empty()).then(|| dedupe(models)),
            error: None,
        }),
        Err(error) => Ok(ApiProviderModelDiscoveryResponse {
            success: false,
            models: None,
            error: Some(error.to_string()),
        }),
    }
}
