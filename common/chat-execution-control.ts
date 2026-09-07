import {
  emptyChatQueueState,
  parseChatQueueState,
  type ChatQueueState,
} from './queue-state.js';

export interface ChatExecutionControlState {
  serverInstanceId: string;
  queue: ChatQueueState;
  version: number;
  updatedAt: string | null;
}

export const MAX_CHAT_EXECUTION_CONTROL_SERVER_INSTANCE_ID_LENGTH = 128;

export function parseExecutionControlServerInstanceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_CHAT_EXECUTION_CONTROL_SERVER_INSTANCE_ID_LENGTH) {
    return null;
  }
  return value.trim() === value ? value : null;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function emptyChatExecutionControlState(
  serverInstanceId: string,
): ChatExecutionControlState {
  return {
    serverInstanceId,
    queue: emptyChatQueueState(),
    version: 0,
    updatedAt: null,
  };
}

export function parseChatExecutionControlState(value: unknown): ChatExecutionControlState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const serverInstanceId = parseExecutionControlServerInstanceId(raw.serverInstanceId);
  const queue = parseChatQueueState(raw.queue);
  if (!serverInstanceId || !queue) return null;
  if (typeof raw.version !== 'number' || !Number.isSafeInteger(raw.version) || raw.version < 0) return null;
  if (raw.updatedAt !== null && !isCanonicalIsoTimestamp(raw.updatedAt)) return null;
  return {
    serverInstanceId,
    queue,
    version: raw.version,
    updatedAt: raw.updatedAt,
  };
}
