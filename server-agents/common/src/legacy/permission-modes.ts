import type { PermissionMode } from './session-types.js';
import { DEFAULT_AGENT_ID } from '@garcon/common/agents';

// Plan mode is a Claude-only permission mode; every other agent shares the same
// base set. Kept here so cross-agent switches can downgrade an unsupported mode.
const CLAUDE_ONLY_PERMISSION_MODES = new Set<PermissionMode>(['plan']);

export function isManualBypassMode(mode: PermissionMode | undefined): boolean {
  return mode === 'manualBypass';
}

export function providerStartupPermissionMode(mode: PermissionMode | undefined): PermissionMode {
  return mode === 'manualBypass' ? 'default' : (mode ?? 'default');
}

export function agentSupportsPermissionMode(agentId: string, mode: PermissionMode): boolean {
  if (agentId === DEFAULT_AGENT_ID) return true;
  return !CLAUDE_ONLY_PERMISSION_MODES.has(mode);
}

// Returns the given mode when the target agent supports it, otherwise 'default'.
export function permissionModeForAgent(agentId: string, mode: PermissionMode): PermissionMode {
  return agentSupportsPermissionMode(agentId, mode) ? mode : 'default';
}
