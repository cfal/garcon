export interface QueueEntry {
  id: string;
  content: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecentlyDispatchedQueueEntry {
  entryId: string;
  dispatchedAt: string;
}

export interface QueueState {
  entries: QueueEntry[];
  dispatchingEntryId: string | null;
  recentlyDispatched: RecentlyDispatchedQueueEntry[];
  paused: boolean;
  version: number;
  updatedAt: string | null;
}

export const MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES = 32;

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeQueueEntry(value: unknown): QueueEntry | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id : '';
  const content = typeof item.content === 'string' ? item.content : null;
  const createdAt = typeof item.createdAt === 'string' ? item.createdAt : '';
  if (!id || content === null || !createdAt) return null;

  return {
    id,
    content,
    revision: positiveInteger(item.revision, 1),
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

export function normalizeQueueState(value: unknown): QueueState {
  if (!value || typeof value !== 'object') {
    return {
      entries: [],
      dispatchingEntryId: null,
      recentlyDispatched: [],
      paused: false,
      version: 0,
      updatedAt: null,
    };
  }

  const raw = value as Record<string, unknown>;
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map(normalizeQueueEntry).filter((entry): entry is QueueEntry => Boolean(entry))
    : [];
  const recentlyDispatched = Array.isArray(raw.recentlyDispatched)
    ? raw.recentlyDispatched
        .map(normalizeRecentlyDispatched)
        .filter((entry): entry is RecentlyDispatchedQueueEntry => Boolean(entry))
        .slice(-MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES)
    : [];

  return {
    entries,
    dispatchingEntryId:
      typeof raw.dispatchingEntryId === 'string' && raw.dispatchingEntryId ? raw.dispatchingEntryId : null,
    recentlyDispatched,
    paused: entries.length > 0 && raw.paused === true,
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) && raw.version >= 0 ? raw.version : 0,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}
