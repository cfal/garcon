import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

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

export class CommandLedger {
  #filePath: string;
  #loaded = false;
  #records = new Map<string, CommandLedgerRecord>();
  #locks = new Map<string, Promise<void>>();

  constructor(workspaceDir: string) {
    this.#filePath = path.join(workspaceDir, 'command-ledger.json');
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

  async #load(): Promise<void> {
    if (this.#loaded) return;
    try {
      const raw = await fs.readFile(this.#filePath, 'utf8');
      const parsed = JSON.parse(raw) as LedgerFile;
      if (parsed.version === 1 && Array.isArray(parsed.records)) {
        this.#records = new Map(parsed.records.map((record) => [record.key, record]));
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.#loaded = true;
  }

  async #persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
    const payload: LedgerFile = {
      version: 1,
      records: [...this.#records.values()].slice(-1000),
    };
    await fs.writeFile(this.#filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    this.#locks.set(key, chain);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(key) === chain) this.#locks.delete(key);
    }
  }
}
