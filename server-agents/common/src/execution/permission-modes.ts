import type { PermissionMode } from '@garcon/common/chat-modes';

export function isManualBypassMode(mode: PermissionMode | undefined): boolean {
  return mode === 'manualBypass';
}

export function providerStartupPermissionMode(
  mode: PermissionMode | undefined,
): PermissionMode {
  return mode === 'manualBypass' ? 'default' : (mode ?? 'default');
}
