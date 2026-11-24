import { InvalidChatIdError, parseChatId } from './chat-id.js';

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function requiredStr(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

export function requiredPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function canonicalChatId(value: unknown): string | null {
  try {
    return parseChatId(value);
  } catch (error) {
    if (error instanceof InvalidChatIdError) return null;
    throw error;
  }
}
