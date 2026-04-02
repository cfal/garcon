// Static model lists shared between server and frontend. OpenCode models
// are fetched dynamically and not included here.

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
  ] satisfies SharedModelOption[],
  DEFAULT: 'opus',
};

export const CODEX_MODELS = {
  OPTIONS: [
    { value: 'gpt-5.4', label: 'GPT-5.4', supportsImages: true },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', supportsImages: true },
    { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', supportsImages: true },
    { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', supportsImages: true },
    { value: 'gpt-5.2', label: 'GPT-5.2', supportsImages: true },
    { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', supportsImages: true },
  ] satisfies SharedModelOption[],
  DEFAULT: 'gpt-5.4',
};

export const AMP_MODELS = {
  OPTIONS: [
    { value: 'default', label: 'Amp Default', supportsImages: false },
  ] satisfies SharedModelOption[],
  DEFAULT: 'default',
};

export const FACTORY_MODELS = {
  OPTIONS: [
    { value: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5', supportsImages: true },
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', supportsImages: true },
    { value: 'claude-opus-4-6-fast', label: 'Claude Opus 4.6 Fast Mode', supportsImages: true },
    { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', supportsImages: true },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', supportsImages: true },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', supportsImages: true },
    { value: 'gpt-5.2', label: 'GPT-5.2', supportsImages: true },
    { value: 'gpt-5.2-codex', label: 'GPT-5.2-Codex', supportsImages: true },
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
    { value: 'gpt-5.1-codex-max', label: 'GPT-5.1-Codex-Max', supportsImages: true },
  ] satisfies SharedModelOption[],
  DEFAULT: 'claude-opus-4-6',
};
