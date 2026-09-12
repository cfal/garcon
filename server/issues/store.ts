import { Database } from 'bun:sqlite';
import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { issueInteger, issueUuid } from '../../common/issue-validation.js';
import { DomainError } from '../lib/domain-error.js';
import { ISSUE_SCHEMA } from './schema.js';
import { issueStorageUnavailable } from './errors.js';

function secureFile(path: string, create: boolean): void {
  let fd: number;
  try {
    const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    fd = openSync(path, create ? flags | constants.O_CREAT | constants.O_EXCL : flags, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (create && code === 'EEXIST') return secureFile(path, false);
    if (!create && code === 'ENOENT') return;
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw issueStorageUnavailable();
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

export interface IssueStoreOptions {
  readonly beforeCommit?: () => void;
}

export class IssueStore {
  #database: Database | null = null;
  readonly storeId: string;

  constructor(workspaceDir: string, private readonly options: IssueStoreOptions = {}) {
    const path = join(workspaceDir, 'issues.sqlite');
    try {
      secureFile(path, true);
      secureFile(`${path}-wal`, false);
      secureFile(`${path}-shm`, false);
      const database = new Database(path, { strict: true });
      this.#database = database;
      database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
      if (version === 0) {
        database.transaction(() => {
          const existing = database.query<{ count: number }, []>(
            "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          ).get();
          if (existing?.count !== 0) throw issueStorageUnavailable();
          database.exec(ISSUE_SCHEMA);
          database.query('INSERT INTO issue_meta VALUES (1, ?, 0)').run(crypto.randomUUID());
        }).immediate();
      } else if (version !== 1) {
        throw issueStorageUnavailable();
      }
      const meta = database.query<{ store_id: string; revision: number }, []>(
        'SELECT store_id, revision FROM issue_meta WHERE singleton=1',
      ).get();
      this.storeId = issueUuid(meta?.store_id, 'storeId');
      issueInteger(meta?.revision, 'collectionRevision', 0);
      secureFile(`${path}-wal`, false);
      secureFile(`${path}-shm`, false);
    } catch {
      this.close();
      throw issueStorageUnavailable();
    }
  }

  read<T>(operation: (database: Database) => T): T {
    if (!this.#database) throw issueStorageUnavailable();
    try { return operation(this.#database); }
    catch (error) {
      if (error instanceof DomainError) throw error;
      this.close();
      throw issueStorageUnavailable();
    }
  }

  transaction<T>(operation: (database: Database) => T): T {
    return this.read((database) => database.transaction(() => {
      const result = operation(database);
      if (result instanceof Promise) throw new Error('Issue transactions must be synchronous.');
      this.options.beforeCommit?.();
      return result;
    }).immediate());
  }

  close(): void {
    const database = this.#database;
    this.#database = null;
    try { database?.close(); }
    catch { /* A failed connection stays fenced even if close also fails. */ }
  }
}
