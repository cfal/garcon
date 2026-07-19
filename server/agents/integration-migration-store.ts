import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentMigrationStore } from '@garcon/server-agent-interface';
import type { JsonValue } from '@garcon/common/json';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';

interface MigrationState {
  version: number;
  values: Record<string, JsonValue>;
}

const locks = new KeyedPromiseLock();

export class FileAgentMigrationStore implements AgentMigrationStore {
  readonly #filePath: string;

  constructor(workspaceDir: string, agentId: string) {
    this.#filePath = path.join(workspaceDir, 'agent-data', agentId, 'migration-state.json');
  }

  async getVersion(): Promise<number> {
    return (await this.#read()).version;
  }

  async read(key: string): Promise<JsonValue | undefined> {
    return (await this.#read()).values[key];
  }

  async commit(request: {
    readonly expectedVersion: number;
    readonly nextVersion: number;
    readonly set: Readonly<Record<string, JsonValue>>;
    readonly delete: readonly string[];
  }): Promise<void> {
    await locks.runExclusive(this.#filePath, async () => {
      const current = await this.#read();
      if (current.version !== request.expectedVersion) {
        throw new Error(
          `Agent migration version changed: expected ${request.expectedVersion}, found ${current.version}`,
        );
      }
      const values = { ...current.values, ...request.set };
      for (const key of request.delete) delete values[key];
      await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
      await writeJsonFileAtomic(this.#filePath, {
        version: request.nextVersion,
        values,
      } satisfies MigrationState);
    });
  }

  async #read(): Promise<MigrationState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.#filePath, 'utf8')) as unknown;
      if (!isMigrationState(parsed)) throw new Error(`Invalid agent migration state: ${this.#filePath}`);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 0, values: {} };
      throw error;
    }
  }
}

function isMigrationState(value: unknown): value is MigrationState {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Number.isSafeInteger((value as MigrationState).version)
    && (value as MigrationState).version >= 0
    && Boolean((value as MigrationState).values)
    && typeof (value as MigrationState).values === 'object'
    && !Array.isArray((value as MigrationState).values);
}
