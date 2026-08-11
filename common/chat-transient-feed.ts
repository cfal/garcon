import { parseChatMessage, type ChatMessage } from './chat-types';

export type ChatTurnReceiptCommandType =
  | 'chat-start'
  | 'agent-run'
  | 'fork-run'
  | 'agent-compact';

export interface ChatTurnReceiptOwner {
  readonly agentOwnershipEpoch: string;
  readonly commandType: ChatTurnReceiptCommandType;
  readonly clientRequestId: string;
  readonly turnId: string;
}

export interface TransientFeedRow {
  readonly id: string;
  readonly incarnation: string;
  readonly operationTurnId: string;
  readonly turnOwner: ChatTurnReceiptOwner;
  readonly transcript: {
    readonly generationId: string;
    readonly afterSeq: number;
  };
  readonly displayOrder: number;
  readonly message: ChatMessage;
}

export type ChatTransientFeedMutationBody =
  | { readonly kind: 'upsert'; readonly row: TransientFeedRow }
  | { readonly kind: 'remove'; readonly id: string; readonly incarnation: string }
  | { readonly kind: 'clear-operation'; readonly turnOwner: ChatTurnReceiptOwner };

export interface ChatTransientFeedMutation {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly agentOwnershipEpoch: string;
  readonly generationId: string;
  readonly transientRevision: number;
  readonly stateDigest: string;
  readonly mutation: ChatTransientFeedMutationBody;
}

export interface ChatProjectionGenerationTransition {
  readonly resetTransactionId: string;
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly agentOwnershipEpoch: string;
  readonly previousGenerationId: string;
  readonly generationId: string;
  readonly transientRevision: number;
  readonly stateDigest: string;
  readonly rows: readonly TransientFeedRow[];
}

export interface ChatTransientFeedSnapshot {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly agentOwnershipEpoch: string;
  readonly generationId: string;
  readonly resetTransactionId: string | null;
  readonly transientRevision: number;
  readonly stateDigest: string;
  readonly rows: readonly TransientFeedRow[];
}

export interface ChatTransientControlAction {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly agentOwnershipEpoch: string;
  readonly turnOwner: ChatTurnReceiptOwner;
  readonly id: string;
  readonly incarnation: string;
}

export function parseChatTurnReceiptOwner(value: unknown): ChatTurnReceiptOwner | null {
  const raw = record(value);
  if (!raw) return null;
  const agentOwnershipEpoch = requiredString(raw.agentOwnershipEpoch);
  const clientRequestId = requiredString(raw.clientRequestId);
  const turnId = requiredString(raw.turnId);
  const commandType = raw.commandType;
  if (!agentOwnershipEpoch || !clientRequestId || !turnId || !isTurnCommandType(commandType)) {
    return null;
  }
  return { agentOwnershipEpoch, commandType, clientRequestId, turnId };
}

export function parseTransientFeedRow(value: unknown): TransientFeedRow | null {
  const raw = record(value);
  if (!raw) return null;
  const transcript = record(raw.transcript);
  const message = record(raw.message);
  const id = requiredString(raw.id);
  const incarnation = requiredString(raw.incarnation);
  const operationTurnId = requiredString(raw.operationTurnId);
  const turnOwner = parseChatTurnReceiptOwner(raw.turnOwner);
  const generationId = transcript ? requiredString(transcript.generationId) : null;
  const afterSeq = transcript ? nonNegativeInteger(transcript.afterSeq) : null;
  const displayOrder = nonNegativeInteger(raw.displayOrder);
  const parsedMessage = message ? parseChatMessage(message) : null;
  if (!id || !incarnation || !operationTurnId || !turnOwner || !generationId
      || afterSeq === null || displayOrder === null || !parsedMessage) {
    return null;
  }
  if (turnOwner.turnId !== operationTurnId) return null;
  return {
    id,
    incarnation,
    operationTurnId,
    turnOwner,
    transcript: { generationId, afterSeq },
    displayOrder,
    message: parsedMessage,
  };
}

export function parseChatTransientFeedSnapshot(value: unknown): ChatTransientFeedSnapshot | null {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.rows)) return null;
  const base = parseFeedBase(raw);
  const parsedResetTransactionId = raw.resetTransactionId === null
    ? null
    : requiredString(raw.resetTransactionId);
  const rows = parseRows(raw.rows);
  if (!base || (raw.resetTransactionId !== null && !parsedResetTransactionId) || !rows) return null;
  if (!rowsAgreeWithBase(rows, base)) return null;
  return { ...base, resetTransactionId: parsedResetTransactionId, rows };
}

export function parseChatTransientFeedMutation(value: unknown): ChatTransientFeedMutation | null {
  const raw = record(value);
  const mutation = raw ? record(raw.mutation) : null;
  const base = raw ? parseFeedBase(raw) : null;
  if (!raw || !mutation || !base) return null;
  let parsedMutation: ChatTransientFeedMutationBody;
  if (mutation.kind === 'upsert') {
    const row = parseTransientFeedRow(mutation.row);
    if (!row || row.transcript.generationId !== base.generationId
        || row.turnOwner.agentOwnershipEpoch !== base.agentOwnershipEpoch) return null;
    parsedMutation = { kind: 'upsert', row };
  } else if (mutation.kind === 'remove') {
    const id = requiredString(mutation.id);
    const incarnation = requiredString(mutation.incarnation);
    if (!id || !incarnation) return null;
    parsedMutation = { kind: 'remove', id, incarnation };
  } else if (mutation.kind === 'clear-operation') {
    const turnOwner = parseChatTurnReceiptOwner(mutation.turnOwner);
    if (!turnOwner || turnOwner.agentOwnershipEpoch !== base.agentOwnershipEpoch) return null;
    parsedMutation = { kind: 'clear-operation', turnOwner };
  } else {
    return null;
  }
  return { ...base, mutation: parsedMutation };
}

export function parseChatProjectionGenerationTransition(
  value: unknown,
): ChatProjectionGenerationTransition | null {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.rows)) return null;
  const base = parseFeedBase(raw);
  const resetTransactionId = requiredString(raw.resetTransactionId);
  const previousGenerationId = requiredString(raw.previousGenerationId);
  const rows = parseRows(raw.rows);
  if (!base || !resetTransactionId || !previousGenerationId || !rows) return null;
  if (previousGenerationId === base.generationId || !rowsAgreeWithBase(rows, base)) return null;
  return { ...base, resetTransactionId, previousGenerationId, rows };
}

export function parseChatTransientControlAction(value: unknown): ChatTransientControlAction | null {
  const raw = record(value);
  if (!raw) return null;
  const serverInstanceId = requiredString(raw.serverInstanceId);
  const chatId = requiredString(raw.chatId);
  const agentOwnershipEpoch = requiredString(raw.agentOwnershipEpoch);
  const turnOwner = parseChatTurnReceiptOwner(raw.turnOwner);
  const id = requiredString(raw.id);
  const incarnation = requiredString(raw.incarnation);
  if (!serverInstanceId || !chatId || !agentOwnershipEpoch || !turnOwner || !id || !incarnation) {
    return null;
  }
  if (turnOwner.agentOwnershipEpoch !== agentOwnershipEpoch) return null;
  return { serverInstanceId, chatId, agentOwnershipEpoch, turnOwner, id, incarnation };
}

function parseFeedBase(raw: Record<string, unknown>): Omit<
  ChatTransientFeedSnapshot,
  'resetTransactionId' | 'rows'
> | null {
  const serverInstanceId = requiredString(raw.serverInstanceId);
  const chatId = requiredString(raw.chatId);
  const agentOwnershipEpoch = requiredString(raw.agentOwnershipEpoch);
  const generationId = requiredString(raw.generationId);
  const transientRevision = nonNegativeInteger(raw.transientRevision);
  const stateDigest = requiredString(raw.stateDigest);
  if (!serverInstanceId || !chatId || !agentOwnershipEpoch || !generationId
      || transientRevision === null || !stateDigest) return null;
  return {
    serverInstanceId,
    chatId,
    agentOwnershipEpoch,
    generationId,
    transientRevision,
    stateDigest,
  };
}

function parseRows(values: readonly unknown[]): TransientFeedRow[] | null {
  const rows: TransientFeedRow[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    const row = parseTransientFeedRow(value);
    if (!row) return null;
    if (ids.has(row.id)) return null;
    ids.add(row.id);
    rows.push(row);
  }
  return rows;
}

function rowsAgreeWithBase(
  rows: readonly TransientFeedRow[],
  base: Pick<ChatTransientFeedSnapshot, 'agentOwnershipEpoch' | 'generationId'>,
): boolean {
  return rows.every((row) => (
    row.turnOwner.agentOwnershipEpoch === base.agentOwnershipEpoch
    && row.transcript.generationId === base.generationId
  ));
}

function isTurnCommandType(value: unknown): value is ChatTurnReceiptCommandType {
  return value === 'chat-start'
    || value === 'agent-run'
    || value === 'fork-run'
    || value === 'agent-compact';
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
