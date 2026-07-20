import {
  emptyChatQueueState,
  parseChatQueueState,
  type ChatQueueState,
} from './queue-state.js';

export interface ChatExecutionControlState {
  queue: ChatQueueState;
  version: number;
  updatedAt: string | null;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function emptyChatExecutionControlState(): ChatExecutionControlState {
  return {
    queue: emptyChatQueueState(),
    version: 0,
    updatedAt: null,
  };
}

export function parseChatExecutionControlState(value: unknown): ChatExecutionControlState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const queue = parseChatQueueState(raw.queue);
  if (!queue) return null;
  if (typeof raw.version !== 'number' || !Number.isSafeInteger(raw.version) || raw.version < 0) return null;
  if (raw.updatedAt !== null && !isCanonicalIsoTimestamp(raw.updatedAt)) return null;
  return {
    queue,
    version: raw.version,
    updatedAt: raw.updatedAt,
  };
}
