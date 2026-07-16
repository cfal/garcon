import {
  MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES,
  type QueueEntry,
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
  paused: boolean;
  version: number;
  updatedAt: string | null;
}

export const MAX_STORED_APPLIED_QUEUE_COMMANDS = 1000;

export function emptyStoredQueue(): StoredQueueState {
  return {
    entries: [],
    recentlyDispatched: [],
    appliedCommands: [],
    paused: false,
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
  const hasQueuedEntries = entries.some((entry) => entry.status === 'queued');

  return {
    entries,
    recentlyDispatched,
    appliedCommands,
    paused: hasQueuedEntries && raw.paused === true,
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) && raw.version >= 0 ? raw.version : 0,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
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
    paused: queue.paused,
    version: queue.version,
    updatedAt: queue.updatedAt,
  };
}
