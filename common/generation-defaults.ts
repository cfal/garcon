// Shared default policy for title/commit generation auto-selection.
// These defaults are used when users have not explicitly configured
// agent/model settings.

import {
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
} from './providers.js';

export const GENERATION_AGENT_PRIORITY = [
  'claude',
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  'codex',
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  'opencode',
  'amp',
  'factory',
] as const;

export const GENERATION_MODEL_DEFAULTS = {
  claude: 'haiku',
  codex: 'gpt-5.5',
  amp: 'smart',
  factory: 'claude-opus-4-6',
} as const;

// Preference order for OpenCode model auto-selection.
// DeepSeek R1 intentionally excluded.
export const OPENCODE_PREFERRED_MODEL_PATTERNS = [
  /glm[-\s]?5/i,
  /kimi[-\s]?2\.?5/i,
  /deepseek[-\s]?v3/i,
] as const;
