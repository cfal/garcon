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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

function hashPayload(payload: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function ledgerKey(commandType: string, chatId: string, clientRequestId: string): string {
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
    const key = ledgerKey(input.commandType, input.chatId, input.clientRequestId);
    return this.#withLock(key, async () => {
      await this.#load();
      const payloadHash = hashPayload(input.payload);
      const existing = this.#records.get(key);
      if (existing) {
        if (existing.payloadHash !== payloadHash) return { kind: 'conflict', record: existing };
        return { kind: 'duplicate', record: existing };
      }

      const now = new Date().toISOString();
      const record: CommandLedgerRecord = {
        key,
        commandType: input.commandType,
        chatId: input.chatId,
        clientRequestId: input.clientRequestId,
        payloadHash,
        payload: input.payload,
        status: 'accepted',
        acceptedAt: now,
        updatedAt: now,
        turnId: input.turnId,
        entryId: input.entryId,
      };
      this.#records.set(key, record);
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
    return this.update(ledgerKey(commandType, chatId, clientRequestId), patch);
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
      await this.#persist();
      return next;
    });
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    const parsed = await this.#store.read();
    this.#records = new Map(parsed.records.map((record) => [record.key, record]));
    this.#loaded = true;
  }

  async #persist(): Promise<void> {
    const payload: LedgerFile = {
      version: 1,
      records: [...this.#records.values()].slice(-1000),
    };
    await this.#store.write(payload);
  }

  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.#locks.runExclusive(key, fn);
  }
}
