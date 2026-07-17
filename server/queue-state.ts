import crypto from 'crypto';
import {
  MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES,
  parseQueuePause,
  type QueueEntry,
  type QueuePause,
  type QueueState,
  type RecentlyDispatchedQueueEntry,
} from '../common/queue-state.ts';

export { MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES } from '../common/queue-state.ts';

export interface StoredQueueEntry extends QueueEntry {
  status: 'queued' | 'sending';
}

export type StoredQueueCommandOperation = 'create' | 'replace' | 'delete';

export interface StoredAppliedQueueCommand {
  key: string;
  operation: StoredQueueCommandOperation;
  entryId: string;
  appliedAt: string;
}

export interface StoredQueueState {
  entries: StoredQueueEntry[];
  recentlyDispatched: RecentlyDispatchedQueueEntry[];
  appliedCommands: StoredAppliedQueueCommand[];
  pause: QueuePause | null;
  version: number;
  updatedAt: string | null;
}

export const MAX_STORED_APPLIED_QUEUE_COMMANDS = 1000;

export function emptyStoredQueue(): StoredQueueState {
  return {
    entries: [],
    recentlyDispatched: [],
    appliedCommands: [],
    pause: null,
    version: 0,
    updatedAt: null,
  };
}

export function cloneStoredQueue(queue: StoredQueueState): StoredQueueState {
  return {
    ...queue,
    entries: queue.entries.map((entry) => ({ ...entry })),
    recentlyDispatched: queue.recentlyDispatched.map((entry) => ({ ...entry })),
    appliedCommands: (queue.appliedCommands ?? []).map((command) => ({
      ...command,
    })),
    pause: queue.pause ? { ...queue.pause } : null,
  };
}

export function bumpStoredQueue(queue: StoredQueueState): StoredQueueState {
  return {
    ...queue,
    version: queue.version + 1,
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

  return {
    id,
    content,
    status,
    revision:
      typeof item.revision === 'number' && Number.isInteger(item.revision) && item.revision > 0 ? item.revision : 1,
    createdAt,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : createdAt,
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

export function storedQueueNeedsCanonicalization(
  value: unknown,
  queue: StoredQueueState,
): boolean {
  return stableStringify(value) !== stableStringify(queue);
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

function normalizeStoredPause(
  raw: Record<string, unknown>,
  entries: StoredQueueEntry[],
  version: number,
  updatedAt: string | null,
): QueuePause | null {
  if (!entries.some((entry) => entry.status === 'queued')) return null;
  if (Object.hasOwn(raw, 'pause')) {
    const pause = parseQueuePause(raw.pause);
    if (pause !== undefined) return pause;
    return migratedPause(raw, entries, version, updatedAt);
  }
  return raw.paused === true ? migratedPause(raw, entries, version, updatedAt) : null;
}

export function normalizeStoredQueueState(value: unknown): StoredQueueState {
  if (!value || typeof value !== 'object') return emptyStoredQueue();
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
        .slice(-MAX_STORED_APPLIED_QUEUE_COMMANDS)
    : [];
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) && raw.version >= 0 ? raw.version : 0;
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;

  return {
    entries,
    recentlyDispatched,
    appliedCommands,
    pause: normalizeStoredPause(raw, entries, version, updatedAt),
    version,
    updatedAt,
  };
}

export function toClientQueueState(queue: StoredQueueState): QueueState {
  return {
    entries: queue.entries
      .filter((entry) => entry.status === 'queued')
      .map(({ status: _status, ...entry }) => ({ ...entry })),
    dispatchingEntryId: queue.entries.find((entry) => entry.status === 'sending')?.id ?? null,
    recentlyDispatched: queue.recentlyDispatched
      .slice(-MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES)
      .map((entry) => ({ ...entry })),
    pause: queue.pause ? { ...queue.pause } : null,
    version: queue.version,
    updatedAt: queue.updatedAt,
  };
}
