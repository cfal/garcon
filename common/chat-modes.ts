// Shared execution mode contracts used across WS parsing, providers,
// and frontend chat state.

export const PERMISSION_MODE_VALUES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
] as const;

export type PermissionMode = typeof PERMISSION_MODE_VALUES[number];

export const THINKING_MODE_VALUES = [
  'none',
  'think',
  'think-hard',
  'think-harder',
  'ultrathink',
] as const;

export type ThinkingMode = typeof THINKING_MODE_VALUES[number];

const PERMISSION_MODE_SET = new Set<string>(PERMISSION_MODE_VALUES);
const THINKING_MODE_SET = new Set<string>(THINKING_MODE_VALUES);

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && PERMISSION_MODE_SET.has(value);
}

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return typeof value === 'string' && THINKING_MODE_SET.has(value);
}
