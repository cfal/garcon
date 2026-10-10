import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import { lstat, open, opendir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CommandResultMessage, parseChatMessage, type ChatMessage } from '@garcon/common/chat-types';
import { AgentIntegrationError, type AgentHost, type AgentNativeSessionRef } from '@garcon/server-agent-interface';
import { syncDirectory } from '@garcon/server-agent-common/lib/json-file-store';
import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ShellNativeStore {
  #directory: Promise<string> | undefined;

  constructor(private readonly host: AgentHost) {}

  directory(): Promise<string> {
    return this.#directory ??= this.#prepareDirectory().catch(error => {
      this.#directory = undefined;
      throw error;
    });
  }

  async #prepareDirectory(): Promise<string> {
    const directory = await this.host.storage.directory('sessions-v1');
    // Scoped storage may create the whole hierarchy; persist every ancestor entry.
    for (let current = directory; ; current = dirname(current)) {
      await syncDirectory(current);
      if (dirname(current) === current) break;
    }
    return directory;
  }

  async initialize(): Promise<void> {
    const directory = await this.directory();
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (entry.name.startsWith('command-')) {
        await rm(join(directory, entry.name), { recursive: true, force: true });
      }
    }
    await syncDirectory(directory);
  }

  reference(sessionId: string): AgentNativeSessionRef {
    if (!ID.test(sessionId)) throw new TypeError('Invalid shell session ID');
    return { ownerId: this.host.agentId, schemaVersion: 1, value: { sessionId } };
  }

  sessionId(ref: AgentNativeSessionRef | null, expected?: string | null): string {
    const id = ref?.value.sessionId;
    if (ref?.ownerId !== this.host.agentId || ref.schemaVersion !== 1 || typeof id !== 'string'
      || !ID.test(id) || (expected && expected !== id)) throw unavailable();
    return id;
  }

  async path(sessionId: string): Promise<string> {
    this.reference(sessionId);
    return join(await this.directory(), `${sessionId}.sqlite`);
  }

  async create(sessionId: string, chatId: string): Promise<NativeLog> {
    const path = await this.path(sessionId);
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    let db: Database | undefined;
    try {
      await file.close();
      db = new Database(path, { strict: true });
      // EXTRA syncs the directory after each DELETE-journal commit.
      db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA;');
      db.exec('CREATE TABLE session (version INTEGER NOT NULL, id TEXT NOT NULL, chat_id TEXT NOT NULL); CREATE TABLE records (seq INTEGER PRIMARY KEY, command_id TEXT NOT NULL, message TEXT NOT NULL, execution TEXT);');
      db.query('INSERT INTO session VALUES (1, ?, ?)').run(sessionId, chatId);
      await syncDirectory(await this.directory());
      return new NativeLog(db);
    } catch (error) {
      db?.close();
      await this.remove(sessionId);
      throw error;
    }
  }

  async load(sessionId: string, chatId: string): Promise<NativeLog> {
    const path = await this.path(sessionId);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw unavailable();
    const db = new Database(path, { strict: true, readwrite: true });
    try {
      db.exec('PRAGMA synchronous = EXTRA;');
      const header = db.query<{ version: number; id: string; chat_id: string }, []>('SELECT * FROM session').all();
      if (header.length !== 1 || header[0]?.version !== 1 || header[0].id !== sessionId || header[0].chat_id !== chatId) throw unavailable();
      if (!db.query('SELECT 1 FROM records LIMIT 1').get()) throw unavailable();
      return new NativeLog(db);
    } catch (error) { db.close(); throw error; }
  }

  async remove(sessionId: string): Promise<void> {
    this.reference(sessionId);
    const directory = await this.directory();
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      await rm(join(directory, `${sessionId}.sqlite${suffix}`), { force: true });
    }
    await syncDirectory(directory);
  }
}

export class NativeLog {
  constructor(private readonly db: Database) {}

  append(commandId: string, message: ChatMessage, execution?: {
    source: string; family: string; executable: string; projectPath: string; executorId: string; format: 'plain' | 'markdown';
  }): void {
    const json = JSON.stringify(message);
    const executionJson = execution ? JSON.stringify(execution) : null;
    this.db.query('INSERT INTO records (command_id, message, execution) VALUES (?, ?, ?)')
      .run(commandId, json, executionJson);
  }

  reconcile(): void {
    const tail = this.db.query<{ command_id: string; message: string }, []>('SELECT command_id, message FROM records ORDER BY seq DESC LIMIT 1').get();
    if (!tail) return;
    const message = parseChatMessage(JSON.parse(tail.message));
    if (!message) throw unavailable();
    if (message.type !== 'command-result') {
      this.append(tail.command_id, new CommandResultMessage(new Date().toISOString(), tail.command_id, {
        outcome: 'unknown', exitCode: null, signal: null, capture: 'incomplete',
        cwd: { kind: 'unavailable', reason: 'The executor found a command without a recorded outcome.' },
      }));
    }
  }

  async *messages(signal: AbortSignal): AsyncIterable<readonly { message: ChatMessage }[]> {
    let seq = 0;
    const steps = new EventLoopSteps('shell-native-import');
    while (true) {
      signal.throwIfAborted();
      const rows = this.db.query<{ seq: number; message: string }, [number]>(
        'SELECT seq, message FROM records WHERE seq > ? ORDER BY seq LIMIT 64',
      ).all(seq);
      if (!rows.length) return;
      const batch: { message: ChatMessage }[] = [];
      for (const row of rows) {
        const message = parseChatMessage(JSON.parse(row.message));
        if (!message || !['user-message', 'command-output', 'command-result'].includes(message.type)
          || (message.type === 'user-message' && message.metadata?.contentMode !== 'literal')) throw unavailable();
        batch.push({ message });
        seq = row.seq;
        await steps.next();
      }
      yield batch;
    }
  }

  close(): void { this.db.close(); }
}

function unavailable(): AgentIntegrationError {
  return new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', 'The selected shell history is missing or invalid.', false);
}
