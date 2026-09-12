import { Database } from 'bun:sqlite';
import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { issueInteger, issueUuid } from '../../common/issue-validation.js';
import { DomainError } from '../lib/domain-error.js';
import { ISSUE_SCHEMA } from './schema.js';
import { issueStorageUnavailable } from './errors.js';
import { diagnosticErrorCode } from '../lib/errors.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('issue-store');

function secureFile(path: string, mode: 'create' | 'required' | 'optional'): void {
  let fd: number;
  try {
    const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    fd = openSync(path, mode === 'create' ? flags | constants.O_CREAT | constants.O_EXCL : flags, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (mode === 'create' && code === 'EEXIST') return secureFile(path, 'required');
    if (mode === 'optional' && code === 'ENOENT') return;
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
      secureFile(path, 'create');
      secureFile(`${path}-wal`, 'optional');
      secureFile(`${path}-shm`, 'optional');
      const database = new Database(path, { strict: true, readwrite: true, create: false });
      this.#database = database;
      secureFile(path, 'required');
      const version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
      if (version === 0) {
        const existing = database.query<{ count: number }, []>(
          "SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        ).get();
        if (existing?.count !== 0) throw issueStorageUnavailable();
      } else if (version !== 1) {
        throw issueStorageUnavailable();
      }
      configureIssueDatabase(database);
      if (version === 0) {
        database.transaction(() => {
          database.exec(ISSUE_SCHEMA);
          database.query('INSERT INTO issue_meta VALUES (1, ?, 0)').run(crypto.randomUUID());
        }).immediate();
      }
      const meta = database.query<{ store_id: string; revision: number }, []>(
        'SELECT store_id, revision FROM issue_meta WHERE singleton=1',
      ).get();
      this.storeId = issueUuid(meta?.store_id, 'storeId');
      issueInteger(meta?.revision, 'collectionRevision', 0);
      requireConsistentLabels(database);
      secureFile(`${path}-wal`, 'optional');
      secureFile(`${path}-shm`, 'optional');
    } catch (error) {
      logger.warn('Issue storage open failed.', { errorCode: diagnosticErrorCode(error) });
      this.close();
      throw issueStorageUnavailable();
    }
  }

  read<T>(operation: (database: Database) => T): T {
    if (!this.#database) throw issueStorageUnavailable();
    try { return operation(this.#database); }
    catch (error) {
      if (error instanceof DomainError) throw error;
      logger.warn('Issue storage fenced.', { errorCode: diagnosticErrorCode(error) });
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

export function configureIssueDatabase(database: Database): void {
  database.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
  const journal = database.query<{ journal_mode: string }, []>('PRAGMA journal_mode=WAL').get();
  const foreignKeys = database.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
  const synchronous = database.query<{ synchronous: number }, []>('PRAGMA synchronous').get();
  if (journal?.journal_mode !== 'wal' || foreignKeys?.foreign_keys !== 1 || synchronous?.synchronous !== 2) {
    throw new Error('Unsupported issue durability configuration.');
  }
}

function requireConsistentLabels(database: Database): void {
  const mismatch = database.query<{ inconsistent: number }, []>(`
    SELECT 1 AS inconsistent WHERE EXISTS (
      SELECT issue_number,label FROM issue_labels
      EXCEPT SELECT i.number,j.value FROM issues i,json_each(i.payload_json,'$.labels') j
    ) OR EXISTS (
      SELECT i.number,j.value FROM issues i,json_each(i.payload_json,'$.labels') j
      EXCEPT SELECT issue_number,label FROM issue_labels
    )
  `).get();
  if (mismatch) throw new Error('Inconsistent issue label index.');
}
