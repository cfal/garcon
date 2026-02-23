export interface QueueEntry {
  id: string;
  content: string;
  status: 'queued' | 'sending';
  createdAt: string;
}

export interface QueueState {
  entries: QueueEntry[];
  paused: boolean;
}

function normalizeQueueEntry(value: unknown): QueueEntry | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id : null;
  const content = typeof item.content === 'string' ? item.content : null;
  const createdAt = typeof item.createdAt === 'string' ? item.createdAt : null;
  const status = item.status === 'queued' || item.status === 'sending'
    ? item.status
    : null;
  if (!id || content === null || !createdAt || !status) return null;
  return { id, content, status, createdAt };
}

// Normalizes untrusted queue payloads from transport boundaries.
// Invalid entries are dropped; paused is forced false when no entries remain.
export function normalizeQueueState(value: unknown): QueueState {
  if (!value || typeof value !== 'object') {
    return { entries: [], paused: false };
  }
  const raw = value as Record<string, unknown>;
  const entries = Array.isArray(raw.entries)
    ? raw.entries
      .map(normalizeQueueEntry)
      .filter((entry): entry is QueueEntry => Boolean(entry))
    : [];

  const paused = entries.length > 0 && raw.paused === true;
  return { entries, paused };
}
