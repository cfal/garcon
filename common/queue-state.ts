export interface QueueEntry {
  id: string;
  content: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecentlyDispatchedQueueEntry {
  entryId: string;
  revision: number;
  dispatchedAt: string;
}

export type QueuePause =
  | { id: string; kind: 'manual'; pausedAt: string }
  | { id: string; kind: 'queued-turn-failed'; entryId: string; pausedAt: string }
  | { id: string; kind: 'completion-uncertain'; entryId: string; pausedAt: string }
  | { id: string; kind: 'unknown'; entryId?: string; pausedAt: string | null };

export type AutomaticQueuePauseKind = Exclude<
  Extract<QueuePause, { entryId: string }>['kind'],
  'unknown'
>;

export interface ChatQueueState {
  entries: QueueEntry[];
  dispatchingEntryId: string | null;
  recentlyDispatched: RecentlyDispatchedQueueEntry[];
  pause: QueuePause | null;
  reorderRevision: number;
}

export const MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES = 32;

export function emptyChatQueueState(): ChatQueueState {
  return {
    entries: [],
    dispatchingEntryId: null,
    recentlyDispatched: [],
    pause: null,
    reorderRevision: 0,
  };
}

function parseQueueEntry(value: unknown): QueueEntry | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  const content = typeof item.content === 'string' ? item.content : null;
  const createdAt = typeof item.createdAt === 'string' ? item.createdAt : '';
  const revision = typeof item.revision === 'number' && Number.isSafeInteger(item.revision) && item.revision > 0
    ? item.revision
    : null;
  const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : '';
  if (!id || content === null || !createdAt || revision === null || !updatedAt) return null;

  return {
    id,
    content,
    revision,
    createdAt,
    updatedAt,
  };
}

function parseRecentlyDispatched(value: unknown): RecentlyDispatchedQueueEntry | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const entryId = typeof item.entryId === 'string' ? item.entryId : '';
  const revision = typeof item.revision === 'number'
    && Number.isSafeInteger(item.revision)
    && item.revision > 0
    ? item.revision
    : null;
  const dispatchedAt = typeof item.dispatchedAt === 'string' ? item.dispatchedAt : '';
  return entryId && revision !== null && dispatchedAt
    ? { entryId, revision, dispatchedAt }
    : null;
}

export function normalizeChatQueueState(value: unknown): ChatQueueState {
  return parseChatQueueState(value) ?? emptyChatQueueState();
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
  if (
    raw.kind === 'queued-turn-failed' ||
    raw.kind === 'completion-uncertain'
  ) {
    const entryId = typeof raw.entryId === 'string' ? raw.entryId.trim() : '';
    return entryId
      ? { id, kind: raw.kind, entryId, pausedAt: raw.pausedAt }
      : undefined;
  }
  return undefined;
}

export function parseChatQueueState(value: unknown): ChatQueueState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const raw = value as Record<string, unknown>;
  const pause = parseQueuePause(raw.pause);
  if (pause === undefined) return null;
  if (!Array.isArray(raw.entries) || !Array.isArray(raw.recentlyDispatched)) return null;
  if (
    typeof raw.reorderRevision !== 'number'
    || !Number.isSafeInteger(raw.reorderRevision)
    || raw.reorderRevision < 0
  ) {
    return null;
  }
  const entries = raw.entries.map(parseQueueEntry);
  const recentlyDispatched = raw.recentlyDispatched.map(parseRecentlyDispatched);
  if (entries.some((entry) => entry === null) || recentlyDispatched.some((entry) => entry === null)) {
    return null;
  }
  const dispatchingEntryId = raw.dispatchingEntryId === null
    ? null
    : typeof raw.dispatchingEntryId === 'string' && raw.dispatchingEntryId.trim()
      ? raw.dispatchingEntryId
      : undefined;
  if (dispatchingEntryId === undefined) return null;

  return {
    entries: entries as QueueEntry[],
    dispatchingEntryId,
    recentlyDispatched: (recentlyDispatched as RecentlyDispatchedQueueEntry[])
      .slice(-MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES),
    pause,
    reorderRevision: raw.reorderRevision,
  };
}
