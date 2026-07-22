import crypto from 'crypto';

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
  forkPreparation?: ForkPreparationState;
}

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
export const PRE_SCHEDULE_FAILURE_ERROR_CODE = 'PRE_SCHEDULE_FAILED';

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
  'active-input',
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
  };
}

export class CommandLedger {
  readonly #records = new Map<string, CommandLedgerRecord>();

  constructor(_workspaceDir?: string) {}

  async getRecord(key: string): Promise<CommandLedgerRecord | null> {
    const record = this.#records.get(key);
    return record ? cloneRecord(record) : null;
  }

  isTerminal(key: string): boolean {
    const record = this.#records.get(key);
    return record !== undefined && TERMINAL_COMMAND_STATUSES.has(record.status);
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

  async accept(input: LedgerAcceptInput): Promise<LedgerAcceptResult> {
    const key = commandLedgerKey(input.commandType, input.chatId, input.clientRequestId);
    const payloadHash = commandPayloadHash(input.payload);
    const existing = this.#records.get(key);
    if (existing) {
      if (existing.payloadHash !== payloadHash) return { kind: 'conflict', record: cloneRecord(existing) };
      if (existing.status === 'failed' && existing.errorCode === PRE_SCHEDULE_FAILURE_ERROR_CODE) {
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
          forkPreparation: undefined,
        };
        this.#records.set(key, record);
        return { kind: 'accepted', record: cloneRecord(record) };
      }
      return { kind: 'duplicate', record: cloneRecord(existing) };
    }

    const conflictingIdentity = [...this.#records.values()].find((record) => (
      record.chatId === input.chatId && record.clientRequestId === input.clientRequestId
    ));
    if (conflictingIdentity) return { kind: 'conflict', record: cloneRecord(conflictingIdentity) };

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
    };
    this.#records.set(key, record);
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
    };
    this.#records.set(key, record);
    this.#trimRecords();
    return { kind: 'applied', record: cloneRecord(record) };
  }

  #trimRecords(): void {
    while (this.#records.size > LEDGER_RECORD_LIMIT) {
      const oldest = [...this.#records]
        .find(([, record]) => (
          TERMINAL_COMMAND_STATUSES.has(record.status) && record.forkPreparation === undefined
        ))?.[0];
      if (!oldest) return;
      this.#records.delete(oldest);
    }
  }
}
