import {
  PermissionRequestMessage,
  parseChatMessage,
  type ChatMessage,
} from './chat-types';

export interface TransientFeedRow {
  readonly permissionOccurrenceId: string;
  readonly runId: string;
  readonly transcript: {
    readonly transcriptViewId: string;
    readonly afterOrdinal: number;
  };
  readonly displayOrder: number;
  readonly message: ChatMessage;
}

export type ChatTransientFeedMutationBody =
  | { readonly kind: 'upsert'; readonly row: TransientFeedRow }
  | { readonly kind: 'remove'; readonly permissionOccurrenceId: string }
  | { readonly kind: 'clear-run'; readonly runId: string };

export interface ChatTransientFeedMutation {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly transientRevision: number;
  readonly mutation: ChatTransientFeedMutationBody;
}

export interface ChatTransientFeedSnapshot {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly transientRevision: number;
  readonly rows: readonly TransientFeedRow[];
}

export interface ChatTransientControlAction {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly runId: string;
  readonly permissionOccurrenceId: string;
}

export function parseTransientFeedRow(value: unknown): TransientFeedRow | null {
  const raw = record(value);
  const transcript = raw ? record(raw.transcript) : null;
  const message = raw ? record(raw.message) : null;
  if (!raw || !transcript || !message) return null;
  const permissionOccurrenceId = requiredString(raw.permissionOccurrenceId);
  const runId = requiredString(raw.runId);
  const transcriptViewId = requiredString(transcript.transcriptViewId);
  const afterOrdinal = nonNegativeInteger(transcript.afterOrdinal);
  const displayOrder = nonNegativeInteger(raw.displayOrder);
  const parsedMessage = parseChatMessage(message);
  if (!permissionOccurrenceId || !runId || !transcriptViewId
      || afterOrdinal === null || displayOrder === null || !parsedMessage) return null;
  if (
    parsedMessage instanceof PermissionRequestMessage
    && parsedMessage.permissionOccurrenceId !== permissionOccurrenceId
  ) return null;
  return {
    permissionOccurrenceId,
    runId,
    transcript: { transcriptViewId, afterOrdinal },
    displayOrder,
    message: parsedMessage,
  };
}

export function parseChatTransientFeedSnapshot(value: unknown): ChatTransientFeedSnapshot | null {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.rows)) return null;
  const base = parseFeedBase(raw);
  const rows = parseRows(raw.rows);
  if (!base || !rows || rows.some((row) => (
    row.transcript.transcriptViewId !== base.transcriptViewId
  ))) return null;
  return { ...base, rows };
}

export function parseChatTransientFeedMutation(value: unknown): ChatTransientFeedMutation | null {
  const raw = record(value);
  const mutation = raw ? record(raw.mutation) : null;
  const base = raw ? parseFeedBase(raw) : null;
  if (!raw || !mutation || !base) return null;
  let parsedMutation: ChatTransientFeedMutationBody;
  if (mutation.kind === 'upsert') {
    const row = parseTransientFeedRow(mutation.row);
    if (!row || row.transcript.transcriptViewId !== base.transcriptViewId) return null;
    parsedMutation = { kind: 'upsert', row };
  } else if (mutation.kind === 'remove') {
    const permissionOccurrenceId = requiredString(mutation.permissionOccurrenceId);
    if (!permissionOccurrenceId) return null;
    parsedMutation = { kind: 'remove', permissionOccurrenceId };
  } else if (mutation.kind === 'clear-run') {
    const runId = requiredString(mutation.runId);
    if (!runId) return null;
    parsedMutation = { kind: 'clear-run', runId };
  } else {
    return null;
  }
  return { ...base, mutation: parsedMutation };
}

export function parseChatTransientControlAction(value: unknown): ChatTransientControlAction | null {
  const raw = record(value);
  if (!raw) return null;
  const serverInstanceId = requiredString(raw.serverInstanceId);
  const chatId = requiredString(raw.chatId);
  const runId = requiredString(raw.runId);
  const permissionOccurrenceId = requiredString(raw.permissionOccurrenceId);
  return serverInstanceId && chatId && runId && permissionOccurrenceId
    ? { serverInstanceId, chatId, runId, permissionOccurrenceId }
    : null;
}

function parseFeedBase(
  raw: Record<string, unknown>,
): Omit<ChatTransientFeedSnapshot, 'rows'> | null {
  const serverInstanceId = requiredString(raw.serverInstanceId);
  const chatId = requiredString(raw.chatId);
  const transcriptViewId = requiredString(raw.transcriptViewId);
  const transientRevision = nonNegativeInteger(raw.transientRevision);
  if (!serverInstanceId || !chatId || !transcriptViewId || transientRevision === null) return null;
  return { serverInstanceId, chatId, transcriptViewId, transientRevision };
}

function parseRows(values: readonly unknown[]): TransientFeedRow[] | null {
  const rows: TransientFeedRow[] = [];
  const occurrences = new Set<string>();
  for (const value of values) {
    const row = parseTransientFeedRow(value);
    if (!row) return null;
    if (occurrences.has(row.permissionOccurrenceId)) return null;
    occurrences.add(row.permissionOccurrenceId);
    rows.push(row);
  }
  return rows;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
