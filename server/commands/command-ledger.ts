import crypto from 'crypto';
import type { ChatStopOutcome } from '../../common/chat-types.js';
import type { SteerDeliveryOutcome } from '../../common/chat-command-contracts.ts';

export type CommandLedgerStatus =
  | 'accepted'
  | 'scheduled'
  | 'running'
  | 'finished'
  | 'failed'
  | 'rejected';

export interface ForkPreparationState {
  phase: 'creating' | 'created';
  sourceChatId: string;
  sourceNextForkOrdinal?: number;
}

export interface CommandLedgerRecord {
  key: string;
  commandType: string;
  chatId: string;
  clientRequestId: string;
  payloadHash: string;
  payload: Record<string, unknown>;
  status: CommandLedgerStatus;
  acceptedAt: string;
  updatedAt: string;
  turnId?: string;
  entryId?: string;
  error?: string;
  errorCode?: string;
  deliveryOutcome?: SteerDeliveryOutcome;
  forkPreparation?: ForkPreparationState;
  stopOutcome?: ChatStopOutcome;
  assistantMessages?: string[];
  assistantBytes?: number;
  turnResultAvailability?:
    | 'available'
    | 'too-large'
    | 'retention-pressure'
    | 'expired';
  interruptionReason?: 'user-stop' | 'chat-deleted';
  publicTerminalAt?: string;
  retainedPrivateTerminal?: true;
  terminalRetentionOrdinal?: number;
}

type SteerCommandTombstone = Omit<
  CommandLedgerRecord,
  'payload' | 'forkPreparation' | 'stopOutcome'
>;

export interface LedgerAcceptInput {
  commandType: string;
  chatId: string;
  clientRequestId: string;
  payload: Record<string, unknown>;
  turnId?: string;
  entryId?: string;
}

export type LedgerAcceptResult =
  | { kind: 'accepted'; record: CommandLedgerRecord }
  | { kind: 'duplicate'; record: CommandLedgerRecord }
  | { kind: 'conflict'; record: CommandLedgerRecord };

export type CommandTerminalStatus = 'finished' | 'failed';
export type CommandTerminalResult =
  | { kind: 'applied'; record: CommandLedgerRecord }
  | { kind: 'duplicate'; record: CommandLedgerRecord }
  | { kind: 'conflict'; record: CommandLedgerRecord };

export const LEDGER_RECORD_LIMIT = 1000;
// Refuses new identities at the limit because eviction could redeliver a native steer.
export const STEER_IDENTITY_LIMIT = 10_000;
export const TURN_RESULT_BYTE_LIMIT = 4 * 1024 * 1024;
export const TOTAL_TURN_RESULT_BYTE_LIMIT = 64 * 1024 * 1024;
export const TURN_RESULT_MESSAGE_LIMIT = 4_096;
export const TOTAL_TURN_RESULT_MESSAGE_LIMIT = 65_536;
export const PRE_SCHEDULE_FAILURE_ERROR_CODE = 'PRE_SCHEDULE_FAILED';

export class SteerIdentityCapacityError extends Error {
  constructor() {
    super('The process-lifetime steering identity capacity is exhausted');
    this.name = 'SteerIdentityCapacityError';
  }
}

export interface CommandLedgerOptions {
  steerIdentityLimit?: number;
  recordLimit?: number;
  turnResultByteLimit?: number;
  totalTurnResultByteLimit?: number;
  turnResultMessageLimit?: number;
  totalTurnResultMessageLimit?: number;
}

const TERMINAL_COMMAND_STATUSES = new Set<CommandLedgerStatus>([
  'finished',
  'failed',
  'rejected',
]);

const QUEUE_RECEIPT_COMMANDS = new Set([
  'queue-entry-create',
  'queue-entry-replace',
  'queue-entry-delete',
  'queue-entry-move',
  'goal-control',
]);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(
      JSON.stringify(entry) === undefined ? null : entry,
    )).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((key) => JSON.stringify(obj[key]) !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',')}}`;
}

function compactAttachment(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const attachment = value as Record<string, unknown>;
  if (typeof attachment.data !== 'string') return value;
  const { data, ...metadata } = attachment;
  return {
    ...metadata,
    dataSha256: crypto.createHash('sha256').update(data).digest('hex'),
    dataLength: data.length,
  };
}

function compactPayloadValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return key === 'images'
      ? value.map(compactAttachment)
      : value.map((item) => compactPayloadValue(item));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entryValue]) => [entryKey, compactPayloadValue(entryValue, entryKey)]),
  );
}

export function compactCommandPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return compactPayloadValue(payload) as Record<string, unknown>;
}

export function commandPayloadHash(payload: Record<string, unknown>): string {
  return crypto.createHash('sha256')
    .update(stableStringify(compactCommandPayload(payload)))
    .digest('hex');
}

export function commandLedgerKey(commandType: string, chatId: string, clientRequestId: string): string {
  return `${commandType}:${chatId}:${clientRequestId}`;
}

function cloneRecord(record: CommandLedgerRecord): CommandLedgerRecord {
  return {
    ...record,
    payload: { ...record.payload },
    ...(record.forkPreparation ? { forkPreparation: { ...record.forkPreparation } } : {}),
    ...(record.assistantMessages ? { assistantMessages: [...record.assistantMessages] } : {}),
  };
}

function recordFromSteerTombstone(tombstone: SteerCommandTombstone): CommandLedgerRecord {
  return { ...tombstone, payload: {} };
}

export class CommandLedger {
  readonly #records = new Map<string, CommandLedgerRecord>();
  readonly #steerTombstones = new Map<string, SteerCommandTombstone>();
  readonly #keysByIdentity = new Map<string, string>();
  readonly #steerIdentityLimit: number;
  #steerIdentityCount = 0;
  readonly #turnOwnerIndex = new Map<string, string>();
  readonly #pendingChatDeletions = new Set<string>();
  readonly #recordLimit: number;
  readonly #turnResultByteLimit: number;
  readonly #totalTurnResultByteLimit: number;
  readonly #turnResultMessageLimit: number;
  readonly #totalTurnResultMessageLimit: number;
  #resultBytes = 0;
  #resultMessages = 0;
  #nextTerminalRetentionOrdinal = 0;

  constructor(_workspaceDir?: string, options: CommandLedgerOptions = {}) {
    this.#steerIdentityLimit = options.steerIdentityLimit ?? STEER_IDENTITY_LIMIT;
    if (!Number.isSafeInteger(this.#steerIdentityLimit) || this.#steerIdentityLimit < 1) {
      throw new Error('steerIdentityLimit must be a positive safe integer');
    }
    this.#recordLimit = options.recordLimit ?? LEDGER_RECORD_LIMIT;
    this.#turnResultByteLimit = options.turnResultByteLimit ?? TURN_RESULT_BYTE_LIMIT;
    this.#totalTurnResultByteLimit = options.totalTurnResultByteLimit
      ?? TOTAL_TURN_RESULT_BYTE_LIMIT;
    this.#turnResultMessageLimit = options.turnResultMessageLimit ?? TURN_RESULT_MESSAGE_LIMIT;
    this.#totalTurnResultMessageLimit = options.totalTurnResultMessageLimit
      ?? TOTAL_TURN_RESULT_MESSAGE_LIMIT;
  }

  async getRecord(key: string): Promise<CommandLedgerRecord | null> {
    const record = this.#records.get(key);
    if (record) return cloneRecord(record);
    const tombstone = this.#steerTombstones.get(key);
    return tombstone ? recordFromSteerTombstone(tombstone) : null;
  }

  async getTurnRecord(chatId: string, turnId: string): Promise<CommandLedgerRecord | null> {
    const key = this.#turnOwnerIndex.get(turnIndexKey(chatId, turnId));
    if (!key) return null;
    const record = this.#records.get(key);
    return record ? cloneRecord(record) : null;
  }

  async appendAssistantMessages(
    chatId: string,
    turnId: string,
    messages: readonly string[],
  ): Promise<CommandLedgerRecord | null> {
    return this.#appendAssistantMessages(this.#recordForTurn(chatId, turnId), messages);
  }

  #appendAssistantMessages(
    record: CommandLedgerRecord | undefined,
    messages: readonly string[],
  ): CommandLedgerRecord | null {
    if (!record || record.publicTerminalAt || record.turnResultAvailability !== 'available') {
      return record ? cloneRecord(record) : null;
    }
    const appended = messages.filter((message) => typeof message === 'string' && message.length > 0);
    if (appended.length === 0) return cloneRecord(record);
    const additionalBytes = appended.reduce((total, message) => total + Buffer.byteLength(message), 0);
    const currentBytes = record.assistantBytes ?? 0;
    const currentMessages = record.assistantMessages?.length ?? 0;
    if (
      currentBytes + additionalBytes > this.#turnResultByteLimit
      || currentMessages + appended.length > this.#turnResultMessageLimit
    ) {
      this.#discardResult(record);
      record.turnResultAvailability = 'too-large';
    } else {
      this.#expireTerminalResults(additionalBytes, appended.length);
      if (
        this.#resultBytes + additionalBytes > this.#totalTurnResultByteLimit
        || this.#resultMessages + appended.length > this.#totalTurnResultMessageLimit
      ) {
        this.#discardResult(record);
        record.turnResultAvailability = 'retention-pressure';
      } else {
        record.assistantMessages = [...(record.assistantMessages ?? []), ...appended];
        record.assistantBytes = currentBytes + additionalBytes;
        this.#resultBytes += additionalBytes;
        this.#resultMessages += appended.length;
      }
    }
    record.updatedAt = new Date().toISOString();
    return cloneRecord(record);
  }

  async markPublicTerminal(
    chatId: string,
    turnId: string,
    interruptionReason?: 'user-stop' | 'chat-deleted',
  ): Promise<CommandLedgerRecord | null> {
    const record = this.#recordForTurn(chatId, turnId);
    if (!record) return null;
    if (record.publicTerminalAt || record.retainedPrivateTerminal) return cloneRecord(record);
    if (interruptionReason) {
      record.interruptionReason = interruptionReason;
      record.status = 'finished';
    }
    if (this.#pendingChatDeletions.has(chatId)) return cloneRecord(record);
    const now = new Date().toISOString();
    record.publicTerminalAt = now;
    record.updatedAt = now;
    record.payload = {};
    this.#assignTerminalRetentionOrdinal(record);
    this.#expireTerminalResults();
    this.#trimRecords();
    return cloneRecord(record);
  }

  beginChatDeletion(chatId: string): void {
    this.#pendingChatDeletions.add(chatId);
  }

  async cancelChatDeletion(chatId: string): Promise<void> {
    if (!this.#pendingChatDeletions.delete(chatId)) return;
    for (const record of this.#records.values()) {
      if (record.chatId !== chatId || !record.turnId || record.publicTerminalAt) continue;
      if (record.interruptionReason === 'chat-deleted') {
        record.interruptionReason = 'user-stop';
      }
      if (TERMINAL_COMMAND_STATUSES.has(record.status)) {
        await this.markPublicTerminal(
          chatId,
          record.turnId,
          record.interruptionReason,
        );
      }
    }
  }

  async markChatInterrupted(
    chatId: string,
    reason: 'chat-deleted',
  ): Promise<void> {
    this.#pendingChatDeletions.delete(chatId);
    for (const record of this.#records.values()) {
      if (record.chatId !== chatId || !record.turnId || record.publicTerminalAt) continue;
      await this.markPublicTerminal(chatId, record.turnId, reason);
    }
  }

  unsettledQueueReceiptKeys(chatId: string): ReadonlySet<string> {
    return new Set(
      [...this.#records.values()]
        .filter((record) => (
          record.chatId === chatId
          && QUEUE_RECEIPT_COMMANDS.has(record.commandType)
          && !TERMINAL_COMMAND_STATUSES.has(record.status)
        ))
        .map((record) => record.key),
    );
  }

  async observe(input: LedgerAcceptInput): Promise<LedgerAcceptResult | null> {
    const key = commandLedgerKey(input.commandType, input.chatId, input.clientRequestId);
    const payloadHash = commandPayloadHash(input.payload);
    const existing = this.#records.get(key);
    if (existing) {
      return existing.payloadHash === payloadHash
        ? { kind: 'duplicate', record: cloneRecord(existing) }
        : { kind: 'conflict', record: cloneRecord(existing) };
    }
    const existingTombstone = this.#steerTombstones.get(key);
    if (existingTombstone) {
      const record = recordFromSteerTombstone(existingTombstone);
      return existingTombstone.payloadHash === payloadHash
        ? { kind: 'duplicate', record }
        : { kind: 'conflict', record };
    }

    const conflictingKey = this.#keysByIdentity.get(
      commandLedgerIdentityKey(input.chatId, input.clientRequestId),
    );
    if (!conflictingKey) return null;
    const conflictingRecord = this.#records.get(conflictingKey);
    const conflictingTombstone = this.#steerTombstones.get(conflictingKey);
    if (!conflictingRecord && !conflictingTombstone) {
      throw new Error(`Command ledger identity index is stale for ${conflictingKey}`);
    }
    return {
      kind: 'conflict',
      record: conflictingRecord
        ? cloneRecord(conflictingRecord)
        : recordFromSteerTombstone(conflictingTombstone!),
    };
  }

  async accept(input: LedgerAcceptInput): Promise<LedgerAcceptResult> {
    const key = commandLedgerKey(input.commandType, input.chatId, input.clientRequestId);
    const payloadHash = commandPayloadHash(input.payload);
    const existing = this.#records.get(key);
    if (existing) {
      if (existing.payloadHash !== payloadHash) return { kind: 'conflict', record: cloneRecord(existing) };
      if (existing.status === 'failed' && existing.errorCode === PRE_SCHEDULE_FAILURE_ERROR_CODE) {
        this.#removeTurnIndex(existing);
        this.#discardResult(existing);
        const now = new Date().toISOString();
        const record: CommandLedgerRecord = {
          ...existing,
          payload: compactCommandPayload(input.payload),
          status: 'accepted',
          acceptedAt: now,
          updatedAt: now,
          turnId: input.turnId,
          entryId: input.entryId,
          error: undefined,
          errorCode: undefined,
          deliveryOutcome: undefined,
          forkPreparation: undefined,
          assistantMessages: [],
          assistantBytes: 0,
          turnResultAvailability: 'available',
          interruptionReason: undefined,
          publicTerminalAt: undefined,
          retainedPrivateTerminal: undefined,
          terminalRetentionOrdinal: undefined,
        };
        this.#records.set(key, record);
        this.#indexTurn(record);
        return { kind: 'accepted', record: cloneRecord(record) };
      }
      return { kind: 'duplicate', record: cloneRecord(existing) };
    }
    const existingTombstone = this.#steerTombstones.get(key);
    if (existingTombstone) {
      const record = recordFromSteerTombstone(existingTombstone);
      return existingTombstone.payloadHash === payloadHash
        ? { kind: 'duplicate', record }
        : { kind: 'conflict', record };
    }

    const identityKey = commandLedgerIdentityKey(input.chatId, input.clientRequestId);
    const conflictingKey = this.#keysByIdentity.get(identityKey);
    if (conflictingKey) {
      const conflictingRecord = this.#records.get(conflictingKey);
      const conflictingTombstone = this.#steerTombstones.get(conflictingKey);
      if (!conflictingRecord && !conflictingTombstone) {
        throw new Error(`Command ledger identity index is stale for ${conflictingKey}`);
      }
      return {
        kind: 'conflict',
        record: conflictingRecord
          ? cloneRecord(conflictingRecord)
          : recordFromSteerTombstone(conflictingTombstone!),
      };
    }
    if (input.commandType === 'steer' && this.#steerIdentityCount >= this.#steerIdentityLimit) {
      throw new SteerIdentityCapacityError();
    }

    const now = new Date().toISOString();
    const record: CommandLedgerRecord = {
      key,
      commandType: input.commandType,
      chatId: input.chatId,
      clientRequestId: input.clientRequestId,
      payloadHash,
      payload: compactCommandPayload(input.payload),
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
      turnId: input.turnId,
      entryId: input.entryId,
      ...(input.turnId ? {
        assistantMessages: [],
        assistantBytes: 0,
        turnResultAvailability: 'available' as const,
      } : {}),
    };
    this.#assertTurnOwnerAvailable(record);
    this.#records.set(key, record);
    this.#keysByIdentity.set(identityKey, key);
    if (input.commandType === 'steer') this.#steerIdentityCount += 1;
    this.#indexTurn(record);
    this.#trimRecords();
    return { kind: 'accepted', record: cloneRecord(record) };
  }

  async update(
    key: string,
    patch: Partial<Omit<CommandLedgerRecord, 'key'>>,
  ): Promise<CommandLedgerRecord | null> {
    const existing = this.#records.get(key);
    if (!existing) return null;
    const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.#assignTerminalRetentionOrdinal(next);
    this.#records.set(key, next);
    this.#trimRecords();
    return cloneRecord(next);
  }

  async updateCommand(
    commandType: string,
    chatId: string,
    clientRequestId: string,
    patch: Partial<Omit<CommandLedgerRecord, 'key'>>,
  ): Promise<CommandLedgerRecord | null> {
    return this.update(commandLedgerKey(commandType, chatId, clientRequestId), patch);
  }

  async updateUnlessStatus(
    key: string,
    blockedStatuses: CommandLedgerStatus[],
    patch: Partial<Omit<CommandLedgerRecord, 'key'>>,
  ): Promise<CommandLedgerRecord | null> {
    const existing = this.#records.get(key);
    if (!existing) return null;
    if (blockedStatuses.includes(existing.status)) return cloneRecord(existing);
    return this.update(key, patch);
  }

  async settleTerminal(
    key: string,
    status: CommandTerminalStatus,
    patch: Partial<Omit<CommandLedgerRecord, 'key' | 'status'>> = {},
  ): Promise<CommandTerminalResult | null> {
    const existing = this.#records.get(key);
    if (!existing) return null;
    if (TERMINAL_COMMAND_STATUSES.has(existing.status)) {
      return {
        kind: existing.status === status ? 'duplicate' : 'conflict',
        record: cloneRecord(existing),
      };
    }
    const record: CommandLedgerRecord = {
      ...existing,
      ...patch,
      status,
      updatedAt: new Date().toISOString(),
      payload: {},
    };
    this.#assignTerminalRetentionOrdinal(record);
    this.#records.set(key, record);
    this.#trimRecords();
    return { kind: 'applied', record: cloneRecord(record) };
  }

  #trimRecords(): void {
    const evictable = [...this.#records]
      .filter(([, record]) => (
        TERMINAL_COMMAND_STATUSES.has(record.status)
        && record.forkPreparation === undefined
        && record.terminalRetentionOrdinal !== undefined
      ))
      .sort(([, left], [, right]) => (
        left.terminalRetentionOrdinal! - right.terminalRetentionOrdinal!
      ));
    while (evictable.length > this.#recordLimit) {
      const oldest = evictable.shift();
      if (!oldest) return;
      const [key, record] = oldest;
      if (record.commandType === 'steer') {
        const {
          payload: _payload,
          forkPreparation: _forkPreparation,
          stopOutcome: _stopOutcome,
          ...tombstone
        } = record;
        this.#steerTombstones.set(key, tombstone);
      } else {
        this.#keysByIdentity.delete(commandLedgerIdentityKey(
          record.chatId,
          record.clientRequestId,
        ));
      }
      this.#removeRecord(key);
    }
  }

  #recordForTurn(chatId: string, turnId: string): CommandLedgerRecord | undefined {
    const key = this.#turnOwnerIndex.get(turnIndexKey(chatId, turnId));
    return key ? this.#records.get(key) : undefined;
  }

  #indexTurn(record: CommandLedgerRecord): void {
    if (!record.turnId) return;
    const indexKey = turnIndexKey(record.chatId, record.turnId);
    if (record.commandType === 'steer') return;
    const owner = this.#turnOwnerIndex.get(indexKey);
    if (owner && owner !== record.key) {
      throw new Error(`Turn ${record.turnId} already has an immutable receipt owner`);
    }
    this.#turnOwnerIndex.set(indexKey, record.key);
  }

  #assertTurnOwnerAvailable(record: CommandLedgerRecord): void {
    if (!record.turnId || record.commandType === 'steer') return;
    const owner = this.#turnOwnerIndex.get(turnIndexKey(record.chatId, record.turnId));
    if (owner && owner !== record.key) {
      throw new Error(`Turn ${record.turnId} already has an immutable receipt owner`);
    }
  }

  #removeTurnIndex(record: CommandLedgerRecord): void {
    if (!record.turnId) return;
    const indexKey = turnIndexKey(record.chatId, record.turnId);
    if (this.#turnOwnerIndex.get(indexKey) === record.key) this.#turnOwnerIndex.delete(indexKey);
  }

  #discardResult(record: CommandLedgerRecord): void {
    this.#resultBytes -= record.assistantBytes ?? 0;
    this.#resultMessages -= record.assistantMessages?.length ?? 0;
    record.assistantMessages = undefined;
    record.assistantBytes = 0;
  }

  #removeRecord(key: string): void {
    const record = this.#records.get(key);
    if (!record) return;
    this.#removeTurnIndex(record);
    this.#discardResult(record);
    this.#records.delete(key);
  }

  #assignTerminalRetentionOrdinal(record: CommandLedgerRecord): void {
    if (
      record.terminalRetentionOrdinal !== undefined
      || !TERMINAL_COMMAND_STATUSES.has(record.status)
      || (record.turnId && !record.publicTerminalAt && !record.retainedPrivateTerminal)
    ) {
      return;
    }
    this.#nextTerminalRetentionOrdinal += 1;
    record.terminalRetentionOrdinal = this.#nextTerminalRetentionOrdinal;
  }

  #expireTerminalResults(requiredBytes = 0, requiredMessages = 0): void {
    while (
      this.#resultBytes + requiredBytes > this.#totalTurnResultByteLimit
      || this.#resultMessages + requiredMessages > this.#totalTurnResultMessageLimit
    ) {
      const oldest = [...this.#records.values()]
        .filter((record) => (
          record.publicTerminalAt !== undefined
          && record.terminalRetentionOrdinal !== undefined
          && record.turnResultAvailability === 'available'
          && ((record.assistantBytes ?? 0) > 0 || (record.assistantMessages?.length ?? 0) > 0)
        ))
        .sort((left, right) => (
          left.terminalRetentionOrdinal! - right.terminalRetentionOrdinal!
        ))[0];
      if (!oldest) return;
      this.#discardResult(oldest);
      oldest.turnResultAvailability = 'expired';
    }
  }
}

function commandLedgerIdentityKey(chatId: string, clientRequestId: string): string {
  return JSON.stringify([chatId, clientRequestId]);
}

function turnIndexKey(chatId: string, turnId: string): string {
  return `${chatId}:${turnId}`;
}
