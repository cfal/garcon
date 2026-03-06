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
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
    { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
    { value: 'gpt-5.2', label: 'GPT-5.2' },
    { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
  ],
  DEFAULT: 'gpt-5.4',
};
