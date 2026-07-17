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

interface LedgerFile {
  version: 1;
  records: CommandLedgerRecord[];
}

const LEDGER_RECORD_LIMIT = 1000;
const LEDGER_PERSIST_LOCK_KEY = 'ledger';
export const PRE_SCHEDULE_FAILURE_ERROR_CODE = 'PRE_SCHEDULE_FAILED';
export const SERVER_RESTART_INTERRUPTED_ERROR_CODE = 'SERVER_RESTART_INTERRUPTED';

const INTERRUPTIBLE_EXECUTION_COMMANDS = new Set([
  'agent-run',
  'fork-run',
  'chat-start',
  'agent-compact',
]);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
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
    return this.#withLock(key, async () => {
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
          this.#records.set(key, record);
          await this.#persist();
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
      this.#records.set(key, record);
      this.#trimRecords();
      await this.#persist();
      return { kind: 'accepted', record };
    });
  }

  async update(key: string, patch: Partial<Omit<CommandLedgerRecord, 'key'>>): Promise<CommandLedgerRecord | null> {
    return this.#withLock(key, async () => {
      await this.#load();
      const existing = this.#records.get(key);
      if (!existing) return null;
      const next = {
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      this.#records.set(key, next);
      this.#trimRecords();
      await this.#persist();
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
    return this.#withLock(key, async () => {
      await this.#load();
      const existing = this.#records.get(key);
      if (!existing) return null;
      if (blockedStatuses.includes(existing.status)) return existing;
      const next = {
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      this.#records.set(key, next);
      this.#trimRecords();
      await this.#persist();
      return next;
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
        if (
          stableStringify(payload) !== stableStringify(storedPayload)
          || payloadHash !== record.payloadHash
          || interrupted
        ) {
          changed = true;
        }
        return {
          ...record,
          payload,
          payloadHash,
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
      this.#records = new Map(records.map((record) => [record.key, record]));
      this.#trimRecords();
      this.#loaded = true;
      if (changed) {
        await this.#store.write({ version: 1, records: [...this.#records.values()] });
      }
    });
  }

  async #persist(): Promise<void> {
    await this.#locks.runExclusive(LEDGER_PERSIST_LOCK_KEY, async () => {
      const payload: LedgerFile = {
        version: 1,
        records: [...this.#records.values()],
      };
      await this.#store.write(payload);
    });
  }

  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.#locks.runExclusive(key, fn);
  }

  #trimRecords(): void {
    while (this.#records.size > LEDGER_RECORD_LIMIT) {
      const oldest = this.#records.keys().next().value;
      if (!oldest) return;
      this.#records.delete(oldest);
    }
  }
}
