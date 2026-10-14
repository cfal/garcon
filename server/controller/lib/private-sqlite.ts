import { Database } from 'bun:sqlite';
import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';

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
    if (!fstatSync(fd).isFile()) throw new Error('SQLite database path is not a regular file.');
    fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function securePrivateSqliteSidecars(path: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const fd = secureFile(`${path}${suffix}`, 'optional');
    if (fd !== null) closeSync(fd);
  }
}

// Opens a workspace database as an owner-only regular file, creating it when
// absent. `afterOpen` runs between the open and the identity check.
export function openPrivateSqliteDatabase(path: string, afterOpen?: () => void): Database {
  const securedFile = secureFile(path, 'create');
  if (securedFile === null) throw new Error('SQLite database could not be secured.');
  let database: Database | null = null;
  try {
    const originalFile = fstatSync(securedFile, { bigint: true });
    securePrivateSqliteSidecars(path);
    database = new Database(path, { strict: true, readwrite: true, create: false });
    afterOpen?.();
    const openedFile = secureFile(path, 'required');
    if (openedFile === null) throw new Error('SQLite database disappeared while opening.');
    try {
      // Detects pathname replacement; SQLite does not expose its fd to exclude a swap-and-restore by another workspace writer.
      const currentFile = fstatSync(openedFile, { bigint: true });
      if (currentFile.dev !== originalFile.dev || currentFile.ino !== originalFile.ino) {
        throw new Error('SQLite database was replaced while opening.');
      }
    } finally { closeSync(openedFile); }
    return database;
  } catch (error) {
    try { database?.close(); }
    catch { /* The open already failed; its error is the one to report. */ }
    throw error;
  } finally {
    closeSync(securedFile);
  }
}

// Requires write-ahead logging with full synchronization and enforced foreign keys.
export function configureDurableSqlite(database: Database): void {
  database.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
  const journal = database.query<{ journal_mode: string }, []>('PRAGMA journal_mode=WAL').get();
  const foreignKeys = database.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
  const synchronous = database.query<{ synchronous: number }, []>('PRAGMA synchronous').get();
  if (journal?.journal_mode !== 'wal' || foreignKeys?.foreign_keys !== 1 || synchronous?.synchronous !== 2) {
    throw new Error('Unsupported SQLite durability configuration.');
  }
}
