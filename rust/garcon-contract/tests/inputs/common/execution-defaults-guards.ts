import { parseAgentSettingsById } from '../../../../../common/agent-integration.ts';
import { isPermissionMode, isThinkingMode } from '../../../../../common/chat-modes.ts';
import { isRecord } from '../../../../../common/json.ts';

export function permissionModes(value: unknown): boolean {
  return Array.isArray(value) && value.every(isPermissionMode);
}

export function thinkingModes(value: unknown): boolean {
  return Array.isArray(value) && value.every(isThinkingMode);
}

function defaults(value: unknown, patch: boolean): boolean {
  return isRecord(value)
    && (patch && value.permissionMode === undefined || isPermissionMode(value.permissionMode))
    && (patch && value.thinkingMode === undefined || isThinkingMode(value.thinkingMode))
    && (patch && value.agentSettingsById === undefined || parseAgentSettingsById(value.agentSettingsById) !== null);
}

export function executionDefaults(value: unknown): boolean {
  return isRecord(value) && defaults(value.global, false) && isRecord(value.byAgent)
    && Object.values(value.byAgent).every((patch) => defaults(patch, true));
}
