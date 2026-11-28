use garcon_agents_common::execution::resolve_endpoint::ResolvedAgentEndpoint;
use garcon_contract::api_providers::ApiProtocol;
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    resources::ExecutorResult,
};
use garcon_js::{array_index, trim};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::{
    build::prepare_compiled_runtime::CompiledCodexModelCatalog, runtime_types::CodexProviderConfig,
};

use super::model_catalog::with_codex_model_catalog;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexEndpointRuntime {
    pub codex_config: CodexProviderConfig,
}

pub fn assert_codex_session_endpoint(
    expected: Option<&str>,
    requested: Option<&str>,
) -> Result<(), AgentIntegrationError> {
    if expected == requested {
        return Ok(());
    }
    Err(AgentIntegrationError::new(
        AgentIntegrationErrorCode::INVALID_ENDPOINT,
        "Codex sessions cannot change model providers. Start a new chat to use a different endpoint, or restore this session's original endpoint.",
        false,
        None,
    ))
}

pub async fn build_codex_app_server_endpoint_runtime(
    endpoint: &ResolvedAgentEndpoint,
    catalog: &CompiledCodexModelCatalog,
) -> ExecutorResult<Option<CodexEndpointRuntime>> {
    let selection = &endpoint.selection;
    if selection.protocol != ApiProtocol::OpenAiCompatible
        || !selection
            .capabilities
            .is_some_and(|capabilities| capabilities.responses)
    {
        return Ok(None);
    }
    let provider_id = codex_provider_id_for_endpoint(&selection.endpoint_id);
    let env_name_suffix = codex_env_name_suffix(&selection.endpoint_id);
    let provider_name = if selection.provider_label.is_empty() {
        &selection.api_provider_id
    } else {
        &selection.provider_label
    };
    let mut provider_config = json!({
        "name": provider_name,
        "base_url": selection.base_url,
        "wire_api": "responses",
        "requires_openai_auth": false,
        "supports_websockets": false,
    });
    let mut env = IndexMap::new();
    if let Some(credential) = endpoint
        .credential
        .as_ref()
        .filter(|credential| !credential.is_empty())
    {
        let env_key = format!("GARCON_CODEX_PROVIDER_API_KEY_{env_name_suffix}");
        provider_config["env_key"] = json!(env_key);
        env.insert(env_key, credential.clone());
    }
    let mut literal_headers = Map::new();
    let mut env_headers = Map::new();
    let mut headers: Vec<_> = selection.headers.iter().collect();
    headers.sort_by_key(|(header, _)| array_index(header).unwrap_or(u64::MAX));
    for (index, (header, value)) in headers.into_iter().enumerate() {
        // Codex skips blank environment values but sends literal blank headers.
        if trim(value).is_empty() {
            literal_headers.insert(header.clone(), json!(value));
            continue;
        }
        let env_name = format!("GARCON_CODEX_PROVIDER_HEADER_{index}_{env_name_suffix}");
        env_headers.insert(header.clone(), json!(env_name));
        env.insert(env_name, value.clone());
    }
    if !literal_headers.is_empty() {
        provider_config["http_headers"] = Value::Object(literal_headers);
    }
    if !env_headers.is_empty() {
        provider_config["env_http_headers"] = Value::Object(env_headers);
    }
    let config = Map::from_iter([
        ("model_provider".into(), json!(provider_id)),
        (
            "model_providers".into(),
            json!({(provider_id): provider_config}),
        ),
    ]);
    let codex_config = with_codex_model_catalog(
        catalog,
        Some(CodexProviderConfig {
            config,
            env: (!env.is_empty()).then_some(env),
            model_catalog_path: None,
        }),
    )
    .await?;
    Ok(Some(CodexEndpointRuntime { codex_config }))
}

pub async fn build_codex_host_provider_config(
    auth_kind: &str,
    catalog: &CompiledCodexModelCatalog,
) -> ExecutorResult<Option<CodexProviderConfig>> {
    if matches!(auth_kind, "api-key" | "external") {
        Ok(Some(with_codex_model_catalog(catalog, None).await?))
    } else {
        Ok(None)
    }
}

fn codex_provider_id_for_endpoint(endpoint_id: &str) -> String {
    let mut provider_id = String::from("garcon_");
    provider_id.extend(endpoint_id.encode_utf16().map(|unit| match unit {
        45 | 48..=57 | 65..=90 | 95 | 97..=122 => char::from_u32(u32::from(unit)).unwrap_or('_'),
        _ => '_',
    }));
    provider_id
}

fn codex_env_name_suffix(endpoint_id: &str) -> String {
    endpoint_id
        .to_uppercase()
        .encode_utf16()
        .map(|unit| match unit {
            48..=57 | 65..=90 => char::from_u32(u32::from(unit)).unwrap_or('_'),
            _ => '_',
        })
        .collect()
}
