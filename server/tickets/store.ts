import { Database } from 'bun:sqlite';
import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { ticketInteger, ticketUuid } from '../../common/ticket-validation.js';
import { DomainError } from '../lib/domain-error.js';
import { TICKET_SCHEMA_V1 } from './schema.js';
import { ticketStorageUnavailable } from './errors.js';
import { diagnosticErrorCode } from '../lib/errors.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('ticket-store');

function secureFile(path: string, mode: 'create' | 'required' | 'optional'): number | null {
  let fd: number;
  try {
    const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    fd = openSync(path, mode === 'create' ? flags | constants.O_CREAT | constants.O_EXCL : flags, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (mode === 'create' && code === 'EEXIST') return secureFile(path, 'required');
    if (mode === 'optional' && code === 'ENOENT') return null;
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw ticketStorageUnavailable();
    fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function secureSidecars(path: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const fd = secureFile(`${path}${suffix}`, 'optional');
    if (fd !== null) closeSync(fd);
  }
}

export interface TicketStoreOptions {
  readonly beforeCommit?: () => void;
  readonly afterDatabaseOpen?: () => void;
}

export class TicketStore {
  #database: Database | null = null;
  readonly storeId: string;

  constructor(workspaceDir: string, private readonly options: TicketStoreOptions = {}) {
    const path = join(workspaceDir, 'tickets.sqlite');
    let securedFile: number | null = null;
    try {
      securedFile = secureFile(path, 'create');
      if (securedFile === null) throw ticketStorageUnavailable();
      const originalFile = fstatSync(securedFile, { bigint: true });
      secureSidecars(path);
      const database = new Database(path, { strict: true, readwrite: true, create: false });
      this.#database = database;
      options.afterDatabaseOpen?.();
      const openedFile = secureFile(path, 'required');
      if (openedFile === null) throw ticketStorageUnavailable();
      try {
        // Detects pathname replacement; SQLite does not expose its fd to exclude a swap-and-restore by another workspace writer.
        const currentFile = fstatSync(openedFile, { bigint: true });
        if (currentFile.dev !== originalFile.dev || currentFile.ino !== originalFile.ino) {
          throw ticketStorageUnavailable();
        }
      } finally { closeSync(openedFile); }
      const version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
      if (version === 0) {
        const existing = database.query<{ count: number }, []>(
          "SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        ).get();
        if (existing?.count !== 0) throw ticketStorageUnavailable();
      } else if (version !== 1) {
        throw ticketStorageUnavailable();
      } else {
        requireTicketSchema(database);
        readStoreId(database);
        requireConsistentLabels(database);
      }
      configureTicketDatabase(database);
      if (version === 0) {
        database.transaction(() => {
          database.exec(TICKET_SCHEMA_V1.join(';\n'));
          database.query('INSERT INTO ticket_meta VALUES (1, ?, 0)').run(crypto.randomUUID());
        }).immediate();
      }
      this.storeId = readStoreId(database);
      secureSidecars(path);
    } catch (error) {
      logger.warn('Ticket storage open failed.', { errorCode: diagnosticErrorCode(error) });
      this.close();
      throw ticketStorageUnavailable();
    } finally {
      if (securedFile !== null) closeSync(securedFile);
    }
  }

  read<T>(operation: (database: Database) => T): T {
    if (!this.#database) throw ticketStorageUnavailable();
    try { return operation(this.#database); }
    catch (error) {
      if (error instanceof DomainError) throw error;
      logger.warn('Ticket storage fenced.', { errorCode: diagnosticErrorCode(error) });
      this.close();
      throw ticketStorageUnavailable();
    }
  }

  transaction<T>(operation: (database: Database) => T): T {
    return this.read((database) => database.transaction(() => {
      const result = operation(database);
      if (result instanceof Promise) throw new Error('Ticket transactions must be synchronous.');
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

function readStoreId(database: Database): string {
  const meta = database.query<{ store_id: string; revision: number }, []>(
    'SELECT store_id, revision FROM ticket_meta WHERE singleton=1',
  ).get();
  ticketInteger(meta?.revision, 'collectionRevision', 0);
  return ticketUuid(meta?.store_id, 'storeId');
}

function requireTicketSchema(database: Database): void {
  const expected = TICKET_SCHEMA_V1.filter((statement) => statement.startsWith('CREATE ')).toSorted();
  const actual = database.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
  ).all().map((row) => row.sql?.trim()).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Unrecognized ticket schema.');
  const integrity = database.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get();
  if (integrity?.quick_check !== 'ok') throw new Error('Invalid ticket database integrity.');
}

export function configureTicketDatabase(database: Database): void {
  database.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
  const journal = database.query<{ journal_mode: string }, []>('PRAGMA journal_mode=WAL').get();
  const foreignKeys = database.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
  const synchronous = database.query<{ synchronous: number }, []>('PRAGMA synchronous').get();
  if (journal?.journal_mode !== 'wal' || foreignKeys?.foreign_keys !== 1 || synchronous?.synchronous !== 2) {
    throw new Error('Unsupported ticket durability configuration.');
  }
}

function requireConsistentLabels(database: Database): void {
  const mismatch = database.query<{ inconsistent: number }, []>(`
    SELECT 1 AS inconsistent WHERE EXISTS (
      SELECT ticket_number,label FROM ticket_labels
      EXCEPT SELECT i.number,j.value FROM tickets i,json_each(i.payload_json,'$.labels') j
    ) OR EXISTS (
      SELECT i.number,j.value FROM tickets i,json_each(i.payload_json,'$.labels') j
      EXCEPT SELECT ticket_number,label FROM ticket_labels
    )
  `).get();
  if (mismatch) throw new Error('Inconsistent ticket label index.');
}
