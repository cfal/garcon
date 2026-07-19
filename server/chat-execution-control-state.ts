import crypto from 'crypto';
import {
  MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES,
  parseQueuePause,
  type QueueEntry,
  type QueuePause,
  type RecentlyDispatchedQueueEntry,
} from '../common/queue-state.ts';
import {
  parseRecoveredInputContinuation,
  type ChatExecutionControlState,
  type RecoveredInputContinuation,
} from '../common/chat-execution-control.ts';

export { MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES } from '../common/queue-state.ts';

export interface StoredQueueDeliveryIdentity {
  clientRequestId: string;
  clientMessageId: string;
  turnId: string;
}

export interface StoredQueueEntry extends QueueEntry {
  status: 'queued' | 'sending';
  delivery?: StoredQueueDeliveryIdentity;
}

export type StoredQueueCommandOperation = 'create' | 'replace' | 'delete';

export interface StoredAppliedQueueCommand {
  key: string;
  operation: StoredQueueCommandOperation;
  entryId: string;
  appliedAt: string;
}

export interface StoredChatExecutionControlState {
  entries: StoredQueueEntry[];
  recentlyDispatched: RecentlyDispatchedQueueEntry[];
  appliedCommands: StoredAppliedQueueCommand[];
  pause: QueuePause | null;
  resumePauses?: QueuePause[];
  recoveredInputContinuation: RecoveredInputContinuation | null;
  version: number;
  updatedAt: string | null;
}

export const MAX_STORED_APPLIED_QUEUE_COMMANDS = 1000;
const MAX_STORED_RESUME_PAUSES = 8;

export function emptyStoredChatExecutionControl(): StoredChatExecutionControlState {
  return {
    entries: [],
    recentlyDispatched: [],
    appliedCommands: [],
    pause: null,
    recoveredInputContinuation: null,
    version: 0,
    updatedAt: null,
  };
}

export function cloneStoredChatExecutionControl(
  control: StoredChatExecutionControlState,
): StoredChatExecutionControlState {
  const clone = {
    ...control,
    entries: control.entries.map((entry) => ({
      ...entry,
      ...(entry.delivery ? { delivery: { ...entry.delivery } } : {}),
    })),
    recentlyDispatched: control.recentlyDispatched.map((entry) => ({ ...entry })),
    appliedCommands: (control.appliedCommands ?? []).map((command) => ({
      ...command,
    })),
    pause: control.pause ? { ...control.pause } : null,
    recoveredInputContinuation: control.recoveredInputContinuation
      ? { ...control.recoveredInputContinuation }
      : null,
  };
  if (control.resumePauses?.length) {
    clone.resumePauses = control.resumePauses.map((pause) => ({ ...pause }));
  } else {
    delete clone.resumePauses;
  }
  return clone;
}

export function bumpStoredChatExecutionControl(
  control: StoredChatExecutionControlState,
): StoredChatExecutionControlState {
  return {
    ...control,
    version: control.version + 1,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeStoredQueueEntry(value: unknown): StoredQueueEntry | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id : '';
  const content = typeof item.content === 'string' ? item.content : null;
  const createdAt = typeof item.createdAt === 'string' ? item.createdAt : '';
  const status = item.status === 'queued' || item.status === 'sending' ? item.status : null;
  if (!id || content === null || !createdAt || !status) return null;

  const rawDelivery = item.delivery && typeof item.delivery === 'object'
    ? item.delivery as Record<string, unknown>
    : null;
  const delivery = rawDelivery
    && typeof rawDelivery.clientRequestId === 'string'
    && rawDelivery.clientRequestId.length > 0
    && typeof rawDelivery.clientMessageId === 'string'
    && rawDelivery.clientMessageId.length > 0
    && typeof rawDelivery.turnId === 'string'
    && rawDelivery.turnId.length > 0
    ? {
        clientRequestId: rawDelivery.clientRequestId,
        clientMessageId: rawDelivery.clientMessageId,
        turnId: rawDelivery.turnId,
      }
    : undefined;

  return {
    id,
    content,
    status,
    revision:
      typeof item.revision === 'number' && Number.isInteger(item.revision) && item.revision > 0 ? item.revision : 1,
    createdAt,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : createdAt,
    ...(delivery ? { delivery } : {}),
  };
}

function normalizeRecentlyDispatched(value: unknown): RecentlyDispatchedQueueEntry | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const entryId = typeof item.entryId === 'string' ? item.entryId : '';
  const dispatchedAt = typeof item.dispatchedAt === 'string' ? item.dispatchedAt : '';
  return entryId && dispatchedAt ? { entryId, dispatchedAt } : null;
}

function normalizeAppliedCommand(value: unknown): StoredAppliedQueueCommand | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const key = typeof item.key === 'string' ? item.key : '';
  const entryId = typeof item.entryId === 'string' ? item.entryId : '';
  const appliedAt = typeof item.appliedAt === 'string' ? item.appliedAt : '';
  const operation =
    item.operation === 'create' || item.operation === 'replace' || item.operation === 'delete' ? item.operation : null;
  return key && entryId && appliedAt && operation ? { key, operation, entryId, appliedAt } : null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function storedChatExecutionControlNeedsCanonicalization(
  value: unknown,
  control: StoredChatExecutionControlState,
): boolean {
  return stableStringify(value) !== stableStringify(control);
}

interface LegacyRecoveredInputPause {
  id: string;
  kind: 'recovered-unconfirmed-input';
  pausedAt: string;
}

type StoredPause = QueuePause | LegacyRecoveredInputPause;

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseStoredPause(value: unknown): StoredPause | null | undefined {
  const pause = parseQueuePause(value);
  if (pause !== undefined) return pause;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (raw.kind !== 'recovered-unconfirmed-input' || !id || !isCanonicalIsoTimestamp(raw.pausedAt)) {
    return undefined;
  }
  return { id, kind: 'recovered-unconfirmed-input', pausedAt: raw.pausedAt };
}

function migratedPause(
  raw: Record<string, unknown>,
  entries: StoredQueueEntry[],
  version: number,
  updatedAt: string | null,
): QueuePause {
  const identity = {
    version,
    updatedAt,
    entryIds: entries.filter((entry) => entry.status === 'queued').map((entry) => entry.id),
    pause: Object.hasOwn(raw, 'pause') ? raw.pause : raw.paused,
  };
  const digest = crypto.createHash('sha256').update(stableStringify(identity)).digest('hex').slice(0, 24);
  const parsedUpdatedAt = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  const timestamp = Number.isFinite(parsedUpdatedAt) && new Date(parsedUpdatedAt).toISOString() === updatedAt
    ? updatedAt
    : null;
  return {
    id: `migrated-${digest}`,
    kind: 'unknown',
    entryId: entries.find((entry) => entry.status === 'queued')?.id,
    pausedAt: timestamp,
  };
}

function normalizeStoredPauses(
  raw: Record<string, unknown>,
  entries: StoredQueueEntry[],
  version: number,
  updatedAt: string | null,
): { pause: QueuePause | null; resumePauses: QueuePause[] } {
  if (entries.length === 0) return { pause: null, resumePauses: [] };
  let active: StoredPause | null;
  if (Object.hasOwn(raw, 'pause')) {
    const parsed = parseStoredPause(raw.pause);
    active = parsed === undefined ? migratedPause(raw, entries, version, updatedAt) : parsed;
  } else {
    active = raw.paused === true ? migratedPause(raw, entries, version, updatedAt) : null;
  }
  const stack = [
    ...(active ? [active] : []),
    ...(Array.isArray(raw.resumePauses)
      ? raw.resumePauses.flatMap((candidate) => {
          const pause = parseStoredPause(candidate);
          return pause ? [pause] : [];
        })
      : []),
  ].filter((pause): pause is QueuePause => pause.kind !== 'recovered-unconfirmed-input');
  return {
    pause: stack[0] ?? null,
    resumePauses: stack.slice(1, MAX_STORED_RESUME_PAUSES + 1),
  };
}

export function normalizeStoredChatExecutionControlState(
  value: unknown,
): StoredChatExecutionControlState {
  if (!value || typeof value !== 'object') return emptyStoredChatExecutionControl();
  const raw = value as Record<string, unknown>;
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map(normalizeStoredQueueEntry).filter((entry): entry is StoredQueueEntry => Boolean(entry))
    : [];
  const recentlyDispatched = Array.isArray(raw.recentlyDispatched)
    ? raw.recentlyDispatched
        .map(normalizeRecentlyDispatched)
        .filter((entry): entry is RecentlyDispatchedQueueEntry => Boolean(entry))
        .slice(-MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES)
    : [];
  const appliedCommands = Array.isArray(raw.appliedCommands)
    ? raw.appliedCommands
        .map(normalizeAppliedCommand)
        .filter((command): command is StoredAppliedQueueCommand => Boolean(command))
    : [];
  const version = typeof raw.version === 'number' && Number.isSafeInteger(raw.version) && raw.version >= 0
    ? raw.version
    : 0;
  const updatedAt = isCanonicalIsoTimestamp(raw.updatedAt) ? raw.updatedAt : null;
  const { pause, resumePauses } = normalizeStoredPauses(raw, entries, version, updatedAt);
  const recoveredInputContinuation = parseRecoveredInputContinuation(raw.recoveredInputContinuation) ?? null;

  return {
    entries,
    recentlyDispatched,
    appliedCommands,
    pause,
    ...(resumePauses.length ? { resumePauses } : {}),
    recoveredInputContinuation,
    version,
    updatedAt,
  };
}

/** Parses durable queue state without discarding entries or idempotency evidence. */
export function parseStoredChatExecutionControlState(value: unknown): StoredChatExecutionControlState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Queue state must be an object');
  }

  const raw = value as Record<string, unknown>;
  if (
    Object.hasOwn(raw, 'version')
    && (typeof raw.version !== 'number' || !Number.isSafeInteger(raw.version) || raw.version < 0)
  ) {
    throw new Error('Queue state version must be a nonnegative safe integer');
  }
  if (
    Object.hasOwn(raw, 'updatedAt')
    && raw.updatedAt !== null
    && !isCanonicalIsoTimestamp(raw.updatedAt)
  ) {
    throw new Error('Queue state updatedAt must be a canonical timestamp or null');
  }
  const arrays = [
    ['entries', normalizeStoredQueueEntry],
    ['recentlyDispatched', normalizeRecentlyDispatched],
    ['appliedCommands', normalizeAppliedCommand],
  ] as const;
  for (const [field, normalize] of arrays) {
    const stored = raw[field];
    if (stored === undefined) continue;
    if (!Array.isArray(stored)) {
      throw new Error(`Queue state ${field} must be an array`);
    }
    if (stored.some((entry) => normalize(entry) === null)) {
      throw new Error(`Queue state ${field} contains an invalid record`);
    }
    if (field === 'entries' && stored.some((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const record = entry as Record<string, unknown>;
      return Object.hasOwn(record, 'delivery')
        && record.delivery !== undefined
        && normalizeStoredQueueEntry(record)?.delivery === undefined;
    })) {
      throw new Error('Queue state entries contain invalid delivery identity');
    }
  }

  if (
    Object.hasOwn(raw, 'recoveredInputContinuation')
    && raw.recoveredInputContinuation !== null
    && !parseRecoveredInputContinuation(raw.recoveredInputContinuation)
  ) {
    throw new Error('Queue state recoveredInputContinuation is invalid');
  }
  if (Array.isArray(raw.resumePauses) && raw.resumePauses.some((pause) => parseStoredPause(pause) === undefined)) {
    throw new Error('Queue state resumePauses contains an invalid pause');
  }
  const normalized = normalizeStoredChatExecutionControlState(raw);
  const entryIds = new Set<string>();
  for (const entry of normalized.entries) {
    if (entryIds.has(entry.id)) {
      throw new Error(`Queue state contains duplicate entry ID: ${entry.id}`);
    }
    entryIds.add(entry.id);
  }
  return normalized;
}

export function toClientChatExecutionControlState(
  control: StoredChatExecutionControlState,
): ChatExecutionControlState {
  return {
    queue: {
      entries: control.entries
        .filter((entry) => entry.status === 'queued')
        .map(({ status: _status, delivery: _delivery, ...entry }) => ({ ...entry })),
      dispatchingEntryId: control.entries.find((entry) => entry.status === 'sending')?.id ?? null,
      recentlyDispatched: control.recentlyDispatched
        .slice(-MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES)
        .map((entry) => ({ ...entry })),
      pause: control.pause ? { ...control.pause } : null,
    },
    recoveredInputContinuation: control.recoveredInputContinuation
      ? { ...control.recoveredInputContinuation }
      : null,
    version: control.version,
    updatedAt: control.updatedAt,
  };
}
