// Shared default policy for title/commit generation auto-selection.
// These defaults are used when users have not explicitly configured
// provider/model settings.

export const GENERATION_PROVIDER_PRIORITY = ['claude', 'codex', 'opencode'] as const;

export const GENERATION_MODEL_DEFAULTS = {
  claude: 'haiku',
  codex: 'gpt-5.1-codex-mini',
  amp: 'default',
} as const;

// Preference order for OpenCode model auto-selection.
// DeepSeek R1 intentionally excluded.
export const OPENCODE_PREFERRED_MODEL_PATTERNS = [
  /glm[-\s]?5/i,
  /kimi[-\s]?2\.?5/i,
  /deepseek[-\s]?v3/i,
] as const;
