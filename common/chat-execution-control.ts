import {
  emptyChatQueueState,
  parseChatQueueState,
  type ChatQueueState,
} from './queue-state.js';

export interface RecoveredInputContinuation {
  id: string;
  installedAt: string;
}

export interface ChatExecutionControlState {
  queue: ChatQueueState;
  recoveredInputContinuation: RecoveredInputContinuation | null;
  version: number;
  updatedAt: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function parseRecoveredInputContinuation(value: unknown): RecoveredInputContinuation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !UUID_RE.test(raw.id)) return null;
  if (!isCanonicalIsoTimestamp(raw.installedAt)) return null;
  return { id: raw.id, installedAt: raw.installedAt };
}

export function emptyChatExecutionControlState(): ChatExecutionControlState {
  return {
    queue: emptyChatQueueState(),
    recoveredInputContinuation: null,
    version: 0,
    updatedAt: null,
  };
}

export function parseChatExecutionControlState(value: unknown): ChatExecutionControlState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const queue = parseChatQueueState(raw.queue);
  if (!queue) return null;
  const continuation = raw.recoveredInputContinuation === null
    ? null
    : parseRecoveredInputContinuation(raw.recoveredInputContinuation);
  if (continuation === null && raw.recoveredInputContinuation !== null) return null;
  if (typeof raw.version !== 'number' || !Number.isSafeInteger(raw.version) || raw.version < 0) return null;
  if (raw.updatedAt !== null && !isCanonicalIsoTimestamp(raw.updatedAt)) return null;
  return {
    queue,
    recoveredInputContinuation: continuation,
    version: raw.version,
    updatedAt: raw.updatedAt,
  };
}

export function normalizeChatExecutionControlState(value: unknown): ChatExecutionControlState {
  return parseChatExecutionControlState(value) ?? emptyChatExecutionControlState();
}
