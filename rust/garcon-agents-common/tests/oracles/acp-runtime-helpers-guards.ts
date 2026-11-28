import { PERMISSION_MODE_VALUES } from '../../../../common/chat-modes.ts';

export function permissionMode(value: unknown) {
  return (PERMISSION_MODE_VALUES as readonly unknown[]).includes(value);
}

export function choice(value: unknown) {
  return ['allow-once', 'allow-always', 'reject', 'auto-approve'].includes(value as string);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function options(value: unknown) {
  return Array.isArray(value) && value.every(record);
}

export function policy(value: unknown) {
  return record(value)
    && typeof value.agentId === 'string'
    && typeof value.command === 'string'
    && (value.acceptsEditsOnClient === undefined || typeof value.acceptsEditsOnClient === 'boolean');
}
