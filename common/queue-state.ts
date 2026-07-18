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

export type QueuePause =
  | { id: string; kind: 'manual'; pausedAt: string }
  | { id: string; kind: 'queued-turn-failed'; entryId: string; pausedAt: string }
  | { id: string; kind: 'recovered-inflight'; entryId: string; pausedAt: string }
  | { id: string; kind: 'recovered-unconfirmed-input'; pausedAt: string }
  | { id: string; kind: 'completion-uncertain'; entryId: string; pausedAt: string }
  | { id: string; kind: 'unknown'; entryId?: string; pausedAt: string | null };

export type AutomaticQueuePauseKind = Exclude<
  Extract<QueuePause, { entryId: string }>['kind'],
  'unknown'
>;

export interface QueueState {
  entries: QueueEntry[];
  dispatchingEntryId: string | null;
  recentlyDispatched: RecentlyDispatchedQueueEntry[];
  pause: QueuePause | null;
  version: number;
  updatedAt: string | null;
}

export const MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES = 32;

export function emptyQueueState(): QueueState {
  return {
    entries: [],
    dispatchingEntryId: null,
    recentlyDispatched: [],
    pause: null,
    version: 0,
    updatedAt: null,
  };
}

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
  return parseQueueState(value) ?? emptyQueueState();
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function parseQueuePause(value: unknown): QueuePause | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return undefined;
  if (raw.kind === 'unknown') {
    if (raw.pausedAt !== null && !isIsoTimestamp(raw.pausedAt)) return undefined;
    const entryId = typeof raw.entryId === 'string' && raw.entryId ? raw.entryId : undefined;
    return { id, kind: 'unknown', ...(entryId ? { entryId } : {}), pausedAt: raw.pausedAt };
  }
  if (!isIsoTimestamp(raw.pausedAt)) return undefined;
  if (raw.kind === 'manual') return { id, kind: 'manual', pausedAt: raw.pausedAt };
  if (raw.kind === 'recovered-unconfirmed-input') {
    return { id, kind: raw.kind, pausedAt: raw.pausedAt };
  }
  if (
    raw.kind === 'queued-turn-failed' ||
    raw.kind === 'recovered-inflight' ||
    raw.kind === 'completion-uncertain'
  ) {
    const entryId = typeof raw.entryId === 'string' ? raw.entryId.trim() : '';
    return entryId
      ? { id, kind: raw.kind, entryId, pausedAt: raw.pausedAt }
      : undefined;
  }
  return undefined;
}

export function parseQueueState(value: unknown): QueueState | null {
  if (!value || typeof value !== 'object') return null;

  const raw = value as Record<string, unknown>;
  const pause = parseQueuePause(raw.pause);
  if (pause === undefined) return null;
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
    pause: entries.length > 0 || pause?.kind === 'recovered-unconfirmed-input' ? pause : null,
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) && raw.version >= 0 ? raw.version : 0,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}
