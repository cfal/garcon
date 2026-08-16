import type { SSEEvent } from './sse-events.js';

// Source of OpenCode permission keys:
// - https://github.com/anomalyco/opencode/blob/f5eade1d2b95562c7fb58e3041e662a8b2b611b6/packages/web/src/content/docs/permissions.mdx
// - https://github.com/anomalyco/opencode/blob/f5eade1d2b95562c7fb58e3041e662a8b2b611b6/packages/opencode/src/agent/agent.ts
export const OPENCODE_PERMISSION_KEYS = Object.freeze([
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'skill',
  'lsp',
  'todoread',
  'todowrite',
  'webfetch',
  'websearch',
  'codesearch',
  'external_directory',
  'doom_loop',
  'question',
  'plan_enter',
  'plan_exit',
] as const);

export function mapPermissionMode(mode: string): Array<{ permission: string; pattern: string; action: string }> {
  const map: Record<string, Record<string, string>> = {
    acceptEdits: { edit: 'allow', bash: 'ask', webfetch: 'allow' },
    bypassPermissions: Object.fromEntries(OPENCODE_PERMISSION_KEYS.map((permission) => [permission, 'allow'])),
    manualBypass: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
    default: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
  };

  const selected = map[mode] || map.default;
  return Object.entries(selected).map(([permission, action]) => ({
    permission,
    pattern: '*',
    action,
  }));
}

export function mapPermissionDecision(
  decision: { allow?: boolean; alwaysAllow?: boolean } | null | undefined,
): string {
  const allow = Boolean(decision?.allow);
  const alwaysAllow = Boolean(decision?.alwaysAllow);
  return allow ? (alwaysAllow ? 'always' : 'once') : 'reject';
}

export function extractPermissionRequest(event: SSEEvent): {
  requestId: string;
  toolInput: Record<string, unknown>;
} | null {
  if (event.type !== 'permission.asked') return null;

  const props = event.properties || {};
  const requestId = props.requestID || props.id;
  if (!requestId) return null;

  return {
    requestId: String(requestId),
    toolInput: {
      permission: props.permission || null,
      patterns: Array.isArray(props.patterns) ? props.patterns : [],
      metadata: props.metadata || {},
      always: Array.isArray(props.always) ? props.always : [],
      tool: props.tool || null,
    },
  };
}
