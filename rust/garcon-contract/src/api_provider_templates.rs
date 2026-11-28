//! Ports common/api-provider-templates.ts.

use std::sync::LazyLock;

use garcon_js::collation::Collation;
use serde::Serialize;

use crate::agents::AgentModelOption;
use crate::api_providers::{ApiProtocol, ModelDiscoveryKind, OpenAiEndpointCapabilities};
use crate::models::{
    ALIBABA_CLOUD_MODELS, FIREWORKS_MODELS, GEMINI_MODELS, OPENROUTER_MODELS, SharedModelOptions,
    TOGETHER_MODELS, ZAI_MODELS,
};

pub use crate::api_providers::ApiProviderTemplateId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderTemplate {
    pub id: ApiProviderTemplateId,
    pub protocol: ApiProtocol,
    pub label: &'static str,
    pub base_url: &'static str,
    pub api_key_placeholder: &'static str,
    pub api_key_required: bool,
    pub default_model: &'static str,
    pub models: Vec<AgentModelOption>,
    pub supports_images: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<OpenAiEndpointCapabilities>,
    pub model_discovery: ModelDiscoveryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub managed_headers: Option<ManagedHeaders>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ManagedHeaders {
    Openrouter,
}

fn model_option(
    value: &str,
    label: &str,
    supports_images: Option<bool>,
    is_local: Option<bool>,
) -> AgentModelOption {
    AgentModelOption {
        value: value.to_owned(),
        label: label.to_owned(),
        supports_images,
        thinking_modes: None,
        is_local,
        api_provider_id: None,
        endpoint_id: None,
        raw_model: None,
        protocol: None,
    }
}

fn options(list: SharedModelOptions) -> Vec<AgentModelOption> {
    list.options
        .iter()
        .map(|option| model_option(option.value, option.label, option.supports_images, None))
        .collect()
}

pub static API_PROVIDER_TEMPLATES: LazyLock<Vec<ApiProviderTemplate>> = LazyLock::new(|| {
    use ApiProtocol::{AnthropicMessages, OpenAiCompatible};
    use ApiProviderTemplateId::{
        AlibabaCloud, Custom, Fireworks, Gemini, Ollama, Openrouter, Together, Zai,
    };
    use ModelDiscoveryKind::{AnthropicModels, OllamaTags, OpenAiModels, OpenRouterModels};

    let chat_only = Some(OpenAiEndpointCapabilities {
        chat_completions: true,
        responses: false,
    });
    let chat_and_responses = Some(OpenAiEndpointCapabilities {
        chat_completions: true,
        responses: true,
    });
    let alibaba = ApiProviderTemplate {
        id: AlibabaCloud,
        protocol: AnthropicMessages,
        label: "Alibaba Cloud",
        base_url: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
        api_key_placeholder: "Alibaba Cloud API key",
        api_key_required: true,
        default_model: ALIBABA_CLOUD_MODELS.default,
        models: options(ALIBABA_CLOUD_MODELS),
        supports_images: false,
        capabilities: None,
        model_discovery: AnthropicModels,
        managed_headers: None,
    };
    let custom = ApiProviderTemplate {
        id: Custom,
        protocol: AnthropicMessages,
        label: "",
        base_url: "",
        api_key_placeholder: "API key or token",
        api_key_required: false,
        default_model: "",
        models: Vec::new(),
        supports_images: false,
        capabilities: None,
        model_discovery: ModelDiscoveryKind::None,
        managed_headers: None,
    };
    let fireworks = ApiProviderTemplate {
        id: Fireworks,
        protocol: AnthropicMessages,
        label: "Fireworks.ai",
        base_url: "https://api.fireworks.ai/inference",
        api_key_placeholder: "Fireworks.ai API key",
        api_key_required: true,
        default_model: FIREWORKS_MODELS.default,
        models: options(FIREWORKS_MODELS),
        supports_images: false,
        capabilities: None,
        model_discovery: AnthropicModels,
        managed_headers: None,
    };
    let ollama = ApiProviderTemplate {
        id: Ollama,
        protocol: AnthropicMessages,
        label: "Ollama",
        base_url: "http://localhost:11434",
        api_key_placeholder: "Leave blank for local Ollama",
        api_key_required: false,
        default_model: "llama3",
        models: vec![model_option("llama3", "llama3 (local)", None, Some(true))],
        supports_images: false,
        capabilities: None,
        model_discovery: OllamaTags,
        managed_headers: None,
    };
    let zai = ApiProviderTemplate {
        id: Zai,
        protocol: AnthropicMessages,
        label: "Z.AI",
        base_url: "https://api.z.ai/api/anthropic",
        api_key_placeholder: "Z.AI API key",
        api_key_required: true,
        default_model: ZAI_MODELS.default,
        models: options(ZAI_MODELS),
        supports_images: false,
        capabilities: None,
        model_discovery: ModelDiscoveryKind::None,
        managed_headers: None,
    };
    vec![
        alibaba.clone(),
        ApiProviderTemplate {
            protocol: OpenAiCompatible,
            base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            capabilities: chat_and_responses,
            model_discovery: OpenAiModels,
            ..alibaba
        },
        custom.clone(),
        ApiProviderTemplate {
            protocol: OpenAiCompatible,
            capabilities: chat_only,
            model_discovery: OpenAiModels,
            ..custom
        },
        fireworks.clone(),
        ApiProviderTemplate {
            protocol: OpenAiCompatible,
            base_url: "https://api.fireworks.ai/inference/v1",
            capabilities: chat_and_responses,
            model_discovery: OpenAiModels,
            ..fireworks
        },
        ApiProviderTemplate {
            id: Gemini,
            protocol: OpenAiCompatible,
            label: "Gemini",
            base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
            api_key_placeholder: "Gemini API key",
            api_key_required: true,
            default_model: GEMINI_MODELS.default,
            models: options(GEMINI_MODELS),
            supports_images: true,
            capabilities: chat_only,
            model_discovery: OpenAiModels,
            managed_headers: None,
        },
        ollama.clone(),
        ApiProviderTemplate {
            protocol: OpenAiCompatible,
            base_url: "http://localhost:11434/v1",
            capabilities: chat_and_responses,
            ..ollama
        },
        ApiProviderTemplate {
            id: Openrouter,
            protocol: OpenAiCompatible,
            label: "OpenRouter",
            base_url: "https://openrouter.ai/api/v1",
            api_key_placeholder: "OpenRouter API key",
            api_key_required: true,
            default_model: OPENROUTER_MODELS.default,
            models: options(OPENROUTER_MODELS),
            supports_images: true,
            capabilities: chat_and_responses,
            model_discovery: OpenRouterModels,
            managed_headers: Some(ManagedHeaders::Openrouter),
        },
        ApiProviderTemplate {
            id: Together,
            protocol: OpenAiCompatible,
            label: "Together.ai",
            base_url: "https://api.together.ai/v1",
            api_key_placeholder: "Together.ai API key",
            api_key_required: true,
            default_model: TOGETHER_MODELS.default,
            models: options(TOGETHER_MODELS),
            supports_images: false,
            capabilities: chat_only,
            model_discovery: OpenAiModels,
            managed_headers: None,
        },
        zai.clone(),
        ApiProviderTemplate {
            protocol: OpenAiCompatible,
            base_url: "https://api.z.ai/api/coding/paas/v4",
            capabilities: chat_only,
            ..zai
        },
    ]
});

pub fn templates_for_protocol(protocol: ApiProtocol) -> Vec<&'static ApiProviderTemplate> {
    let mut templates: Vec<_> = API_PROVIDER_TEMPLATES
        .iter()
        .filter(|template| template.protocol == protocol)
        .collect();
    let collation = Collation::english_numeric_base();
    templates.sort_by(|left, right| {
        let left_custom = left.id == ApiProviderTemplateId::Custom;
        let right_custom = right.id == ApiProviderTemplateId::Custom;
        left_custom.cmp(&right_custom).then_with(|| {
            if left_custom {
                std::cmp::Ordering::Equal
            } else {
                collation.compare(left.label, right.label)
            }
        })
    });
    templates
}

pub fn api_provider_template(
    protocol: ApiProtocol,
    template_id: ApiProviderTemplateId,
) -> Option<&'static ApiProviderTemplate> {
    API_PROVIDER_TEMPLATES
        .iter()
        .find(|template| template.protocol == protocol && template.id == template_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_lookup_is_protocol_qualified() {
        assert!(
            api_provider_template(
                ApiProtocol::AnthropicMessages,
                ApiProviderTemplateId::Gemini
            )
            .is_none()
        );
        let template =
            api_provider_template(ApiProtocol::OpenAiCompatible, ApiProviderTemplateId::Gemini)
                .unwrap();
        assert!(template.supports_images);
        assert!(!template.capabilities.unwrap().responses);
    }

    #[test]
    fn custom_is_last_for_each_protocol() {
        for protocol in [
            ApiProtocol::AnthropicMessages,
            ApiProtocol::OpenAiCompatible,
        ] {
            let templates = templates_for_protocol(protocol);
            assert!(
                templates
                    .iter()
                    .all(|template| template.protocol == protocol)
            );
            assert_eq!(templates.last().unwrap().id, ApiProviderTemplateId::Custom);
        }
    }
}
