import { isPermissionMode } from '../../../../../common/chat-modes.ts';
import { executionDefaults } from './execution-defaults-guards.ts';

export function startSelectionSettings(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('executionDefaults' in value)) return false;
  return executionDefaults(value.executionDefaults);
}

export function requestedStartSelection(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return !('permissionMode' in value) || value.permissionMode === undefined || isPermissionMode(value.permissionMode);
}

export function startSelectionErrorCode(value: unknown): boolean {
  return [
    'UNKNOWN_AGENT', 'INVALID_CATALOG', 'PROVIDER_NOT_SUPPORTED', 'UNKNOWN_PROVIDER',
    'AMBIGUOUS_PROVIDER', 'UNKNOWN_ENDPOINT', 'INCOMPATIBLE_ENDPOINT', 'AMBIGUOUS_MODEL',
    'UNKNOWN_MODEL', 'UNSUPPORTED_PERMISSION_MODE', 'UNSUPPORTED_REASONING_EFFORT',
    'PERMISSION_OVERRIDE_REQUIRED',
  ].includes(value as string);
}
