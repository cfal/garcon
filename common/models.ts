// Static model lists shared between server and frontend. Provider-owned
// model catalogs such as Cursor and OpenCode are fetched dynamically.

export interface SharedModelOption {
  value: string;
  label: string;
  supportsImages?: boolean;
}

export const CLAUDE_MODELS = {
  OPTIONS: [
    { value: 'opus', label: 'Opus', supportsImages: true },
    { value: 'sonnet', label: 'Sonnet', supportsImages: true },
    { value: 'haiku', label: 'Haiku', supportsImages: true },
    { value: 'fable', label: 'Fable', supportsImages: true },
  ] satisfies SharedModelOption[],
  DEFAULT: 'opus',
};

export const CODEX_MODELS = {
  OPTIONS: [
    { value: 'gpt-5.5', label: 'GPT-5.5', supportsImages: true },
    { value: 'gpt-5.4', label: 'GPT-5.4', supportsImages: true },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', supportsImages: true },
    { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', supportsImages: false },
  ] satisfies SharedModelOption[],
  DEFAULT: 'gpt-5.5',
};

export const AMP_MODELS = {
  OPTIONS: [
    { value: 'smart', label: 'Amp Smart', supportsImages: false },
    { value: 'deep', label: 'Amp Deep', supportsImages: false },
  ] satisfies SharedModelOption[],
  DEFAULT: 'smart',
};

export const FACTORY_MODELS = {
  OPTIONS: [
    { value: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5', supportsImages: true },
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', supportsImages: true },
    { value: 'claude-opus-4-6-fast', label: 'Claude Opus 4.6 Fast Mode', supportsImages: true },
    { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', supportsImages: true },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', supportsImages: true },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', supportsImages: true },
    { value: 'gpt-5.4', label: 'GPT-5.4', supportsImages: true },
    { value: 'gpt-5.4-fast', label: 'GPT-5.4 Fast Mode', supportsImages: true },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', supportsImages: true },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', supportsImages: true },
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', supportsImages: false },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', supportsImages: false },
    { value: 'glm-4.7', label: 'Droid Core (GLM-4.7)', supportsImages: false },
    { value: 'glm-5', label: 'Droid Core (GLM-5)', supportsImages: false },
    { value: 'kimi-k2.5', label: 'Droid Core (Kimi K2.5)', supportsImages: true },
    { value: 'minimax-m2.5', label: 'Droid Core (MiniMax M2.5)', supportsImages: false },
  ] satisfies SharedModelOption[],
  DEFAULT: 'claude-opus-4-6',
};

export const PI_MODELS = {
  OPTIONS: [] satisfies SharedModelOption[],
  DEFAULT: '',
};

export const OPENROUTER_MODELS = {
  OPTIONS: [
    { value: 'anthropic/claude-opus-4.6', label: 'Claude Opus 4.6', supportsImages: true },
    { value: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', supportsImages: true },
    { value: 'openai/gpt-5.4', label: 'GPT-5.4', supportsImages: true },
    { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini', supportsImages: true },
    { value: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', supportsImages: true },
    { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', supportsImages: true },
    { value: 'x-ai/grok-4.20', label: 'Grok 4.20', supportsImages: true },
    { value: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2', supportsImages: false },
    { value: 'deepseek/deepseek-r1', label: 'DeepSeek R1', supportsImages: false },
    { value: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick', supportsImages: true },
    { value: 'qwen/qwen3.6-plus', label: 'Qwen 3.6 Plus', supportsImages: true },
  ] satisfies SharedModelOption[],
  DEFAULT: 'anthropic/claude-sonnet-4.6',
};

export const ALIBABA_CLOUD_MODELS = {
  OPTIONS: [
    { value: 'qwen-plus', label: 'Qwen Plus', supportsImages: false },
    { value: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', supportsImages: false },
    { value: 'qwen3-max-preview', label: 'Qwen3 Max Preview', supportsImages: false },
  ] satisfies SharedModelOption[],
  DEFAULT: 'qwen-plus',
};

export const FIREWORKS_MODELS = {
  OPTIONS: [
    { value: 'accounts/fireworks/models/deepseek-v3p2', label: 'DeepSeek V3.2', supportsImages: false },
    { value: 'accounts/fireworks/models/kimi-k2p5', label: 'Kimi K2.5', supportsImages: false },
  ] satisfies SharedModelOption[],
  DEFAULT: 'accounts/fireworks/models/kimi-k2p5',
};

export const GEMINI_MODELS = {
  OPTIONS: [
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', supportsImages: true },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', supportsImages: true },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', supportsImages: true },
    { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', supportsImages: true },
  ] satisfies SharedModelOption[],
  DEFAULT: 'gemini-3-flash-preview',
};

export const TOGETHER_MODELS = {
  OPTIONS: [
    { value: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', supportsImages: false },
  ] satisfies SharedModelOption[],
  DEFAULT: 'openai/gpt-oss-20b',
};

export const ZAI_MODELS = {
  OPTIONS: [
    { value: 'glm-5.1', label: 'GLM-5.1', supportsImages: false },
  ] satisfies SharedModelOption[],
  DEFAULT: 'glm-5.1',
};
