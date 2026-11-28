//! Ports common/models.ts.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedModelOption {
    pub value: &'static str,
    pub label: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_images: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub struct SharedModelOptions {
    pub options: &'static [SharedModelOption],
    pub default: &'static str,
}

const fn model(
    value: &'static str,
    label: &'static str,
    supports_images: bool,
) -> SharedModelOption {
    SharedModelOption {
        value,
        label,
        supports_images: Some(supports_images),
    }
}

pub const CLAUDE_MODELS: SharedModelOptions = SharedModelOptions {
    options: &[
        model("opus", "Opus", true),
        model("sonnet", "Sonnet", true),
        model("haiku", "Haiku", true),
        model("fable", "Fable", true),
    ],
    default: "opus",
};

pub const GPT_6_ASTRA_MODEL: &str = "gpt-6-astra";
pub const GPT_6_2_SOL_MODEL: &str = "gpt-6.2-sol";
pub const GPT_6_2_ASTRA_MODEL: &str = "gpt-6.2-astra";
pub const GPT_6_1_SOL_MODEL: &str = "gpt-6.1-sol";
pub const GPT_6_1_TERRA_MODEL: &str = "gpt-6.1-terra";
pub const GPT_6_SOL_MODEL: &str = "gpt-6-sol";
pub const GPT_6_LUNA_MODEL: &str = "gpt-6-luna";

pub fn is_codex_sol_model(model: Option<&str>) -> bool {
    matches!(
        model.and_then(|model| model.rsplit(':').next()),
        Some(GPT_6_2_SOL_MODEL | GPT_6_1_SOL_MODEL | GPT_6_SOL_MODEL | "gpt-5.6-sol")
    )
}

pub const CODEX_MODELS: SharedModelOptions = SharedModelOptions {
    options: &[
        model("gpt-5.5", "GPT-5.5", true),
        model(GPT_6_2_SOL_MODEL, "GPT-6.2-Sol", true),
        model(GPT_6_2_ASTRA_MODEL, "GPT-6.2-Astra", true),
        model(GPT_6_ASTRA_MODEL, "GPT-6-Astra", true),
        model(GPT_6_1_SOL_MODEL, "GPT-6.1-Sol", true),
        model(GPT_6_1_TERRA_MODEL, "GPT-6.1-Terra", true),
        model(GPT_6_SOL_MODEL, "GPT-6-Sol", true),
        model(GPT_6_LUNA_MODEL, "GPT-6-Luna", true),
        model("gpt-5.6-sol", "GPT-5.6-Sol", true),
        model("gpt-5.6-terra", "GPT-5.6-Terra", true),
        model("gpt-5.6-luna", "GPT-5.6-Luna", true),
        model("gpt-5.4", "GPT-5.4", true),
        model("gpt-5.3-codex", "GPT-5.3 Codex", true),
        model("gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", false),
    ],
    default: GPT_6_SOL_MODEL,
};

pub const AMP_MODELS: SharedModelOptions = SharedModelOptions {
    options: &[
        model("low", "Amp Low", true),
        model("medium", "Amp Medium", true),
        model("high", "Amp High", true),
        model("ultra", "Amp Ultra", true),
    ],
    default: "medium",
};

pub const FACTORY_MODELS: SharedModelOptions = SharedModelOptions {
    options: &[
        model("claude-opus-4-5-20251101", "Claude Opus 4.5", true),
        model("claude-opus-4-6", "Claude Opus 4.6", true),
        model("claude-opus-4-6-fast", "Claude Opus 4.6 Fast Mode", true),
        model("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", true),
        model("claude-sonnet-4-6", "Claude Sonnet 4.6", true),
        model("claude-haiku-4-5-20251001", "Claude Haiku 4.5", true),
        model("gpt-5.4", "GPT-5.4", true),
        model("gpt-5.4-fast", "GPT-5.4 Fast Mode", true),
        model("gpt-5.4-mini", "GPT-5.4 Mini", true),
        model("gpt-5.3-codex", "GPT-5.3-Codex", true),
        model("gemini-3.1-pro-preview", "Gemini 3.1 Pro", false),
        model("gemini-3-flash-preview", "Gemini 3 Flash", false),
        model("glm-4.7", "Droid Core (GLM-4.7)", false),
        model("glm-5", "Droid Core (GLM-5)", false),
        model("kimi-k2.5", "Droid Core (Kimi K2.5)", true),
        model("minimax-m2.5", "Droid Core (MiniMax M2.5)", false),
    ],
    default: "claude-opus-4-6",
};

pub const PI_MODELS: SharedModelOptions = SharedModelOptions {
    options: &[],
    default: "",
};

pub const OPENROUTER_MODELS: SharedModelOptions = SharedModelOptions {
    options: &[
        model("anthropic/claude-opus-4.6", "Claude Opus 4.6", true),
        model("anthropic/claude-sonnet-4.6", "Claude Sonnet 4.6", true),
        model("openai/gpt-5.4", "GPT-5.4", true),
        model("openai/gpt-5.4-mini", "GPT-5.4 Mini", true),
        model("google/gemini-3.1-pro-preview", "Gemini 3.1 Pro", true),
        model("google/gemini-2.5-flash", "Gemini 2.5 Flash", true),
        model("x-ai/grok-4.20", "Grok 4.20", true),
        model("deepseek/deepseek-v3.2", "DeepSeek V3.2", false),
        model("deepseek/deepseek-r1", "DeepSeek R1", false),
        model("meta-llama/llama-4-maverick", "Llama 4 Maverick", true),
        model("qwen/qwen3.6-plus", "Qwen 3.6 Plus", true),
    ],
    default: "anthropic/claude-sonnet-4.6",
};

pub const ALIBABA_CLOUD_MODELS: SharedModelOptions = SharedModelOptions {
    options: &[
        model("qwen-plus", "Qwen Plus", false),
        model("qwen3-coder-plus", "Qwen3 Coder Plus", false),
        model("qwen3-max-preview", "Qwen3 Max Preview", false),
    ],
    default: "qwen-plus",
};

pub const FIREWORKS_MODELS: SharedModelOptions = SharedModelOptions {
    options: &[
        model(
            "accounts/fireworks/models/deepseek-v3p2",
            "DeepSeek V3.2",
            false,
        ),
        model("accounts/fireworks/models/kimi-k2p5", "Kimi K2.5", false),
    ],
    default: "accounts/fireworks/models/kimi-k2p5",
};

pub const GEMINI_MODELS: SharedModelOptions = SharedModelOptions {
    options: &[
        model("gemini-2.5-flash", "Gemini 2.5 Flash", true),
        model("gemini-2.5-pro", "Gemini 2.5 Pro", true),
        model("gemini-3-flash-preview", "Gemini 3 Flash Preview", true),
        model("gemini-3-pro-preview", "Gemini 3 Pro Preview", true),
    ],
    default: "gemini-3-flash-preview",
};

pub const TOGETHER_MODELS: SharedModelOptions = SharedModelOptions {
    options: &[model("openai/gpt-oss-20b", "GPT-OSS 20B", false)],
    default: "openai/gpt-oss-20b",
};

pub const ZAI_MODELS: SharedModelOptions = SharedModelOptions {
    options: &[model("glm-5.1", "GLM-5.1", false)],
    default: "glm-5.1",
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_codex_6_2_models_without_changing_the_default() {
        for (value, label) in [
            ("gpt-6.2-sol", "GPT-6.2-Sol"),
            ("gpt-6.2-astra", "GPT-6.2-Astra"),
        ] {
            assert_eq!(
                CODEX_MODELS
                    .options
                    .iter()
                    .find(|option| option.value == value),
                Some(&model(value, label, true))
            );
        }
        assert_eq!(CODEX_MODELS.default, "gpt-6-sol");
    }

    #[test]
    fn recognizes_bare_and_endpoint_qualified_sol_only() {
        for value in [
            "gpt-6.2-sol",
            "endpoint:gpt-6.2-sol",
            "gpt-6.1-sol",
            "gpt-6-sol",
            "gpt-5.6-sol",
        ] {
            assert!(is_codex_sol_model(Some(value)));
        }
        for value in [
            Some("gpt-6.2-astra"),
            Some("endpoint:gpt-6.2-astra"),
            Some("not-gpt-6.2-sol"),
            None,
        ] {
            assert!(!is_codex_sol_model(value));
        }
    }
}
