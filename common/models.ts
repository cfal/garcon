// Static model lists shared between server and frontend. OpenCode models
// are fetched dynamically and not included here.

export const CLAUDE_MODELS = {
  OPTIONS: [
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
  ],
  DEFAULT: 'opus',
};

export const CODEX_MODELS = {
  OPTIONS: [
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
    { value: 'gpt-5.2', label: 'GPT-5.2' },
    { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
    { value: 'o3-pro', label: 'o3-pro' },
    { value: 'o3', label: 'o3' },
    { value: 'o4-mini', label: 'o4-mini' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
    { value: 'gpt-4.1-nano', label: 'GPT-4.1 nano' },
  ],
  DEFAULT: 'gpt-5.3-codex',
};
