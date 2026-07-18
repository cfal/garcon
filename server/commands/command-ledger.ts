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
  const parsed = value as Partial<LedgerFile> | null;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
    return { version: 1, records: [] };
  }
  return {
    version: 1,
    records: parsed.records.filter((record): record is CommandLedgerRecord => {
      return Boolean(
        record
        && typeof record.key === 'string'
        && typeof record.commandType === 'string'
        && typeof record.chatId === 'string'
        && typeof record.clientRequestId === 'string'
        && typeof record.payloadHash === 'string',
      );
    }),
  };
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
          };
          const nextRecords = new Map(this.#records);
          nextRecords.set(key, record);
          await this.#commit(nextRecords);
          return { kind: 'accepted', record };
        }
        return { kind: 'duplicate', record: existing };
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
            && !interruptedExecution;
        })?.[0];
      if (!oldest) return;
      records.delete(oldest);
    }
  }
}
