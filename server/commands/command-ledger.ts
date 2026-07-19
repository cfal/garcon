import path from 'path';
import crypto from 'crypto';
import { JsonFileStore } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';

export type CommandLedgerStatus =
  | 'accepted'
  | 'scheduled'
  | 'running'
  | 'finished'
  | 'failed'
  | 'rejected';

export type PendingInputRecoveryStatus = 'required' | 'settled';

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
  pendingInputRecovery?: PendingInputRecoveryStatus;
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

interface LedgerFile {
  version: 1;
  records: CommandLedgerRecord[];
}

const LEDGER_RECORD_LIMIT = 1000;
const LEDGER_PERSIST_LOCK_KEY = 'ledger';
const LEDGER_MUTATION_LOCK_KEY = 'ledger-mutation';
export const PRE_SCHEDULE_FAILURE_ERROR_CODE = 'PRE_SCHEDULE_FAILED';
export const SERVER_RESTART_INTERRUPTED_ERROR_CODE = 'SERVER_RESTART_INTERRUPTED';

const INTERRUPTIBLE_EXECUTION_COMMANDS = new Set([
  'agent-run',
  'fork-run',
  'chat-start',
  'agent-compact',
  'active-input',
]);

const USER_INPUT_EXECUTION_COMMANDS = new Set([
  'agent-run',
  'fork-run',
  'chat-start',
  'active-input',
]);

const TERMINAL_COMMAND_STATUSES = new Set<CommandLedgerStatus>([
  'finished',
  'failed',
  'rejected',
]);

const COMMAND_LEDGER_STATUSES = new Set<CommandLedgerStatus>([
  'accepted',
  'scheduled',
  'running',
  'finished',
  'failed',
  'rejected',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid command ledger ${field}`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, field);
}

function parseLedgerRecord(value: unknown, index: number): CommandLedgerRecord {
  if (!isPlainRecord(value)) {
    throw new Error(`Invalid command ledger record at index ${index}`);
  }
  const commandType = requireNonEmptyString(value.commandType, `records[${index}].commandType`);
  const chatId = requireNonEmptyString(value.chatId, `records[${index}].chatId`);
  const clientRequestId = requireNonEmptyString(
    value.clientRequestId,
    `records[${index}].clientRequestId`,
  );
  const key = requireNonEmptyString(value.key, `records[${index}].key`);
  if (key !== commandLedgerKey(commandType, chatId, clientRequestId)) {
    throw new Error(`Invalid command ledger key at index ${index}`);
  }
  if (!isPlainRecord(value.payload)) {
    throw new Error(`Invalid command ledger records[${index}].payload`);
  }
  if (!COMMAND_LEDGER_STATUSES.has(value.status as CommandLedgerStatus)) {
    throw new Error(`Invalid command ledger records[${index}].status`);
  }
  if (
    value.pendingInputRecovery !== undefined
    && value.pendingInputRecovery !== 'required'
    && value.pendingInputRecovery !== 'settled'
  ) {
    throw new Error(`Invalid command ledger records[${index}].pendingInputRecovery`);
  }
  let forkPreparation: ForkPreparationState | undefined;
  if (value.forkPreparation !== undefined) {
    if (!isPlainRecord(value.forkPreparation)) {
      throw new Error(`Invalid command ledger records[${index}].forkPreparation`);
    }
    const phase = value.forkPreparation.phase;
    const sourceChatId = value.forkPreparation.sourceChatId;
    const sourceNextForkOrdinal = value.forkPreparation.sourceNextForkOrdinal;
    if (
      (phase !== 'creating' && phase !== 'created')
      || typeof sourceChatId !== 'string'
      || sourceChatId.length === 0
      || (
        sourceNextForkOrdinal !== undefined
        && (
          typeof sourceNextForkOrdinal !== 'number'
          || !Number.isInteger(sourceNextForkOrdinal)
          || sourceNextForkOrdinal < 1
        )
      )
    ) {
      throw new Error(`Invalid command ledger records[${index}].forkPreparation`);
    }
    forkPreparation = {
      phase,
      sourceChatId,
      ...(sourceNextForkOrdinal !== undefined ? { sourceNextForkOrdinal } : {}),
    };
  }
  return {
    key,
    commandType,
    chatId,
    clientRequestId,
    payloadHash: requireNonEmptyString(value.payloadHash, `records[${index}].payloadHash`),
    payload: value.payload,
    status: value.status as CommandLedgerStatus,
    acceptedAt: requireNonEmptyString(value.acceptedAt, `records[${index}].acceptedAt`),
    updatedAt: requireNonEmptyString(value.updatedAt, `records[${index}].updatedAt`),
    ...(optionalNonEmptyString(value.turnId, `records[${index}].turnId`) !== undefined
      ? { turnId: value.turnId as string }
      : {}),
    ...(optionalNonEmptyString(value.entryId, `records[${index}].entryId`) !== undefined
      ? { entryId: value.entryId as string }
      : {}),
    ...(optionalNonEmptyString(value.error, `records[${index}].error`) !== undefined
      ? { error: value.error as string }
      : {}),
    ...(optionalNonEmptyString(value.errorCode, `records[${index}].errorCode`) !== undefined
      ? { errorCode: value.errorCode as string }
      : {}),
    ...(value.pendingInputRecovery !== undefined
      ? { pendingInputRecovery: value.pendingInputRecovery as PendingInputRecoveryStatus }
      : {}),
    ...(forkPreparation ? { forkPreparation } : {}),
  };
}

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
      .map(([entryKey, entryValue]) => [
        entryKey,
        compactPayloadValue(entryValue, entryKey),
      ]),
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

function normalizeLedgerFile(value: unknown): LedgerFile {
  if (!isPlainRecord(value) || value.version !== 1 || !Array.isArray(value.records)) {
    throw new Error('Invalid command ledger file');
  }
  const records = value.records.map(parseLedgerRecord);
  const keys = new Set<string>();
  const requestIdentities = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (keys.has(record.key)) {
      throw new Error(`Duplicate command ledger key at index ${index}`);
    }
    keys.add(record.key);
    const requestIdentity = JSON.stringify([record.chatId, record.clientRequestId]);
    if (requestIdentities.has(requestIdentity)) {
      throw new Error(`Duplicate command ledger request identity at index ${index}`);
    }
    requestIdentities.add(requestIdentity);
  }
  return { version: 1, records };
}

export class CommandLedger {
  #store: JsonFileStore<LedgerFile>;
  #loaded = false;
  #records = new Map<string, CommandLedgerRecord>();
  #locks = new KeyedPromiseLock();

  constructor(workspaceDir: string) {
    const filePath = path.join(workspaceDir, 'command-ledger.json');
    this.#store = new JsonFileStore<LedgerFile>({
      filePath,
      empty: () => ({ version: 1, records: [] }),
      normalize: normalizeLedgerFile,
    });
  }

  async accept(input: LedgerAcceptInput): Promise<LedgerAcceptResult> {
    const key = commandLedgerKey(input.commandType, input.chatId, input.clientRequestId);
    return this.#withMutationLock(async () => {
      await this.#load();
      const payloadHash = commandPayloadHash(input.payload);
      const existing = this.#records.get(key);
      if (existing) {
        if (existing.payloadHash !== payloadHash) return { kind: 'conflict', record: existing };
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
          const nextRecords = new Map(this.#records);
          nextRecords.set(key, record);
          await this.#commit(nextRecords);
          return { kind: 'accepted', record };
        }
        return { kind: 'duplicate', record: existing };
      }
      const conflictingIdentity = [...this.#records.values()].find((record) => (
        record.chatId === input.chatId
        && record.clientRequestId === input.clientRequestId
      ));
      if (conflictingIdentity) return { kind: 'conflict', record: conflictingIdentity };

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
      const nextRecords = new Map(this.#records);
      nextRecords.set(key, record);
      this.#trimRecords(nextRecords);
      await this.#commit(nextRecords);
      return { kind: 'accepted', record };
    });
  }

  async update(key: string, patch: Partial<Omit<CommandLedgerRecord, 'key'>>): Promise<CommandLedgerRecord | null> {
    return this.#withMutationLock(async () => {
      await this.#load();
      const existing = this.#records.get(key);
      if (!existing) return null;
      const next = {
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      const nextRecords = new Map(this.#records);
      nextRecords.set(key, next);
      this.#trimRecords(nextRecords);
      await this.#commit(nextRecords);
      return next;
    });
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
    return this.#withMutationLock(async () => {
      await this.#load();
      const existing = this.#records.get(key);
      if (!existing) return null;
      if (blockedStatuses.includes(existing.status)) return existing;
      const next = {
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      const nextRecords = new Map(this.#records);
      nextRecords.set(key, next);
      this.#trimRecords(nextRecords);
      await this.#commit(nextRecords);
      return next;
    });
  }

  async settleTerminal(
    key: string,
    status: CommandTerminalStatus,
    patch: Partial<Omit<CommandLedgerRecord, 'key' | 'status'>> = {},
  ): Promise<CommandTerminalResult | null> {
    return this.#withMutationLock(async () => {
      await this.#load();
      const existing = this.#records.get(key);
      if (!existing) return null;
      if (TERMINAL_COMMAND_STATUSES.has(existing.status)) {
        return {
          kind: existing.status === status ? 'duplicate' : 'conflict',
          record: existing,
        };
      }
      const record: CommandLedgerRecord = {
        ...existing,
        ...patch,
        status,
        updatedAt: new Date().toISOString(),
      };
      const nextRecords = new Map(this.#records);
      nextRecords.set(key, record);
      this.#trimRecords(nextRecords);
      await this.#commit(nextRecords);
      return { kind: 'applied', record };
    });
  }

  async listPendingInputRecoveries(): Promise<CommandLedgerRecord[]> {
    await this.#load();
    return [...this.#records.values()]
      .filter((record) => record.pendingInputRecovery === 'required')
      .map((record) => ({
        ...record,
        payload: { ...record.payload },
      }));
  }

  async listForkPreparationsPendingRecovery(): Promise<CommandLedgerRecord[]> {
    await this.#load();
    return [...this.#records.values()]
      .filter((record) => (
        record.commandType === 'fork-run'
        && record.forkPreparation !== undefined
      ))
      .map((record) => ({ ...record, payload: { ...record.payload } }));
  }

  async settleForkPreparationRecovery(key: string): Promise<boolean> {
    return this.#withMutationLock(async () => {
      await this.#load();
      const existing = this.#records.get(key);
      if (!existing?.forkPreparation) return false;
      const nextRecords = new Map(this.#records);
      nextRecords.set(key, {
        ...existing,
        forkPreparation: undefined,
        updatedAt: new Date().toISOString(),
      });
      await this.#commit(nextRecords);
      return true;
    });
  }

  async settlePendingInputRecovery(chatId: string, clientRequestId: string): Promise<boolean> {
    return this.#withMutationLock(async () => {
      await this.#load();
      let changed = false;
      const nextRecords = new Map(this.#records);
      for (const [key, record] of this.#records) {
        if (
          record.chatId !== chatId
          || record.clientRequestId !== clientRequestId
          || record.pendingInputRecovery !== 'required'
        ) {
          continue;
        }
        nextRecords.set(key, {
          ...record,
          pendingInputRecovery: 'settled',
          updatedAt: new Date().toISOString(),
        });
        changed = true;
      }
      if (!changed) return false;
      this.#trimRecords(nextRecords);
      await this.#commit(nextRecords);
      return true;
    });
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    await this.#locks.runExclusive(LEDGER_PERSIST_LOCK_KEY, async () => {
      if (this.#loaded) return;
      const parsed = await this.#store.read();
      let changed = false;
      const records = parsed.records.map((record) => {
        const storedPayload = record.payload && typeof record.payload === 'object'
          ? record.payload
          : {};
        const payload = compactCommandPayload(storedPayload);
        const payloadHash = commandPayloadHash(payload);
        const interrupted = INTERRUPTIBLE_EXECUTION_COMMANDS.has(record.commandType)
          && (record.status === 'accepted' || record.status === 'scheduled' || record.status === 'running');
        const recoversUserInput = USER_INPUT_EXECUTION_COMMANDS.has(record.commandType);
        const priorRecovery = record.pendingInputRecovery === 'required'
          || record.pendingInputRecovery === 'settled'
          ? record.pendingInputRecovery
          : undefined;
        const legacyUnsettledFailure = recoversUserInput
          && record.status === 'failed'
          && record.errorCode !== PRE_SCHEDULE_FAILURE_ERROR_CODE
          && priorRecovery !== 'settled';
        const pendingInputRecovery = priorRecovery
          ?? ((interrupted && recoversUserInput) || legacyUnsettledFailure
            ? 'required' as const
            : undefined);
        if (
          stableStringify(payload) !== stableStringify(storedPayload)
          || payloadHash !== record.payloadHash
          || interrupted
          || pendingInputRecovery !== record.pendingInputRecovery
        ) {
          changed = true;
        }
        return {
          ...record,
          payload,
          payloadHash,
          ...(pendingInputRecovery ? { pendingInputRecovery } : {}),
          ...(interrupted
            ? {
              status: 'failed' as const,
              updatedAt: new Date().toISOString(),
              error: 'Server restarted before command completion was recorded',
              errorCode: SERVER_RESTART_INTERRUPTED_ERROR_CODE,
            }
            : {}),
        };
      });
      const nextRecords = new Map(records.map((record) => [record.key, record]));
      const untrimmedSize = nextRecords.size;
      this.#trimRecords(nextRecords);
      if (nextRecords.size !== untrimmedSize) changed = true;
      if (changed) {
        await this.#writeRecords(nextRecords);
      }
      this.#records = nextRecords;
      this.#loaded = true;
    });
  }

  async #commit(nextRecords: Map<string, CommandLedgerRecord>): Promise<void> {
    await this.#persist(nextRecords);
    this.#records = nextRecords;
  }

  async #persist(records: Map<string, CommandLedgerRecord>): Promise<void> {
    await this.#locks.runExclusive(LEDGER_PERSIST_LOCK_KEY, async () => {
      await this.#writeRecords(records);
    });
  }

  async #writeRecords(records: Map<string, CommandLedgerRecord>): Promise<void> {
    const payload: LedgerFile = {
      version: 1,
      records: [...records.values()],
    };
    try {
      await this.#store.write(payload);
    } catch (error) {
      // Atomic rename can succeed before a directory sync reports failure.
      try {
        const persisted = await this.#store.read();
        if (stableStringify(persisted) === stableStringify(payload)) return;
      } catch {
        // Preserves the original write error.
      }
      throw error;
    }
  }

  async #withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.#locks.runExclusive(LEDGER_MUTATION_LOCK_KEY, fn);
  }

  #trimRecords(records: Map<string, CommandLedgerRecord>): void {
    while (records.size > LEDGER_RECORD_LIMIT) {
      const oldest = [...records]
        .find(([, record]) => {
          const interruptedExecution = INTERRUPTIBLE_EXECUTION_COMMANDS.has(record.commandType)
            && record.errorCode === SERVER_RESTART_INTERRUPTED_ERROR_CODE;
          return TERMINAL_COMMAND_STATUSES.has(record.status)
            && record.pendingInputRecovery !== 'required'
            && record.forkPreparation === undefined
            && !interruptedExecution;
        })?.[0];
      if (!oldest) return;
      records.delete(oldest);
    }
  }
}
