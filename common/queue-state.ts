export interface QueueEntry {
  id: string;
  content: string;
  status: 'queued' | 'sending';
  createdAt: string;
}

export interface QueueState {
  entries: QueueEntry[];
  paused: boolean;
  version?: number;
  updatedAt?: string;
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

// Projects a queue to its client-facing form. The 'sending' status is an
// internal dispatch marker: the entry stays in the queue for the duration of
// its turn so a failed turn can be re-queued and a crashed turn recovered, but
// the message has already been written to the transcript as a pending user
// input. Exposing the 'sending' entry to clients duplicates that transcript
// message and desyncs the pending-count badge, so it is stripped at every
// boundary that crosses to the client. Returns the same reference when nothing
// is stripped to avoid needless version churn.
export function toClientQueueState(queue: QueueState): QueueState {
  const entries = queue.entries.filter((entry) => entry.status === 'queued');
  if (entries.length === queue.entries.length) return queue;
  return { ...queue, entries, paused: entries.length > 0 && queue.paused };
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
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : undefined;
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined;
  return { entries, paused, version, updatedAt };
}
