import {
  normalizePermissionMode,
  normalizeThinkingMode,
  type PermissionMode,
  type ThinkingMode,
} from './chat-modes.js';
import type { ExecutionDefaults, RemoteExecutionDefaults } from './settings.js';

export function normalizeSupportedPermissionMode(
  value: unknown,
  supported: readonly PermissionMode[],
): PermissionMode {
  const normalized = normalizePermissionMode(value);
  if (supported.includes(normalized)) return normalized;
  return supported[0] ?? 'default';
}

export function normalizeSupportedThinkingMode(
  value: unknown,
  supported: readonly ThinkingMode[],
): ThinkingMode {
  const normalized = normalizeThinkingMode(value);
  if (supported.includes(normalized)) return normalized;
  return supported[0] ?? 'none';
}

export function executionDefaultsForAgent(
  defaults: RemoteExecutionDefaults | null | undefined,
  agentId: string,
): ExecutionDefaults {
  if (!defaults) {
    return {
      permissionMode: 'default',
      thinkingMode: 'none',
      agentSettingsById: {},
    };
  }
  const override = defaults.byAgent[agentId];
  return {
    permissionMode: override?.permissionMode ?? defaults.global.permissionMode,
    thinkingMode: override?.thinkingMode ?? defaults.global.thinkingMode,
    agentSettingsById: {
      ...defaults.global.agentSettingsById,
      ...(override?.agentSettingsById ?? {}),
    },
  };
}
