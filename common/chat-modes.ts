// Shared execution mode contracts used across WS parsing, providers,
// and frontend chat state.

export const PERMISSION_MODE_VALUES = [
  'default',
  'acceptEdits',
  'manualBypass',
  'bypassPermissions',
  'plan',
] as const;

export type PermissionMode = typeof PERMISSION_MODE_VALUES[number];
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

export const THINKING_MODE_VALUES = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ThinkingMode = typeof THINKING_MODE_VALUES[number];
export const DEFAULT_THINKING_MODE: ThinkingMode = 'none';

// Pre-effort-label values persisted by older chats and settings.
// Accepted on normalization so stored data keeps working.
const LEGACY_THINKING_MODE_ALIASES: Record<string, ThinkingMode> = {
  'think': 'low',
  'think-hard': 'medium',
  'think-harder': 'high',
  'ultrathink': 'max',
};

export const CLAUDE_THINKING_MODE_VALUES = [
  'auto',
  'on',
  'off',
] as const;

export type ClaudeThinkingMode = typeof CLAUDE_THINKING_MODE_VALUES[number];
export const DEFAULT_CLAUDE_THINKING_MODE: ClaudeThinkingMode = 'auto';

const PERMISSION_MODE_SET = new Set<string>(PERMISSION_MODE_VALUES);
const THINKING_MODE_SET = new Set<string>(THINKING_MODE_VALUES);
const CLAUDE_THINKING_MODE_SET = new Set<string>(CLAUDE_THINKING_MODE_VALUES);

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && PERMISSION_MODE_SET.has(value);
}

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return typeof value === 'string' && THINKING_MODE_SET.has(value);
}

export function isClaudeThinkingMode(value: unknown): value is ClaudeThinkingMode {
  return typeof value === 'string' && CLAUDE_THINKING_MODE_SET.has(value);
}

export function normalizePermissionMode(
  value: unknown,
  fallback: PermissionMode = DEFAULT_PERMISSION_MODE,
): PermissionMode {
  return isPermissionMode(value) ? value : fallback;
}

// Resolves canonical values and legacy aliases; returns null for anything else.
export function coerceThinkingMode(value: unknown): ThinkingMode | null {
  if (isThinkingMode(value)) return value;
  if (typeof value === 'string' && value in LEGACY_THINKING_MODE_ALIASES) {
    return LEGACY_THINKING_MODE_ALIASES[value];
  }
  return null;
}

export function normalizeThinkingMode(
  value: unknown,
  fallback: ThinkingMode = DEFAULT_THINKING_MODE,
): ThinkingMode {
  return coerceThinkingMode(value) ?? fallback;
}

export function normalizeClaudeThinkingMode(
  value: unknown,
  fallback: ClaudeThinkingMode = DEFAULT_CLAUDE_THINKING_MODE,
): ClaudeThinkingMode {
  return isClaudeThinkingMode(value) ? value : fallback;
}

export const AMP_AGENT_MODE_VALUES = [
  'smart',
  'deep',
] as const;

export type AmpAgentMode = typeof AMP_AGENT_MODE_VALUES[number];
export const DEFAULT_AMP_AGENT_MODE: AmpAgentMode = 'smart';

const AMP_AGENT_MODE_SET = new Set<string>(AMP_AGENT_MODE_VALUES);

export function isAmpAgentMode(value: unknown): value is AmpAgentMode {
  return typeof value === 'string' && AMP_AGENT_MODE_SET.has(value);
}

export function normalizeAmpAgentMode(
  value: unknown,
  fallback: AmpAgentMode = DEFAULT_AMP_AGENT_MODE,
): AmpAgentMode {
  return isAmpAgentMode(value) ? value : fallback;
}
