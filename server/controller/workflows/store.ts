import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { DomainError } from '../../common/domain-error.js';
import { diagnosticErrorCode } from '../../common/errors.js';
import { createLogger } from '../../common/log.js';
import { configureDurableSqlite, openPrivateSqliteDatabase, securePrivateSqliteSidecars } from '../lib/private-sqlite.js';
import { WORKFLOW_SCHEMA, WORKFLOW_SCHEMA_VERSION } from './schema.js';

const logger = createLogger('workflow-store');

function unavailable(): DomainError {
  return new DomainError('INTERNAL_ERROR', 'Workflow storage is unavailable.', 503);
}

export class WorkflowStore {
  #database: Database | null = null;

  constructor(workspaceDir: string, private readonly beforeCommit?: () => void) {
    const path = join(workspaceDir, 'workflow-runs.sqlite');
    try {
      const db = this.#database = openPrivateSqliteDatabase(path);
      configureDurableSqlite(db);
      db.transaction(() => {
        const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
        if (version === 0) db.exec(`${WORKFLOW_SCHEMA} PRAGMA user_version = ${WORKFLOW_SCHEMA_VERSION}`);
        else if (version !== WORKFLOW_SCHEMA_VERSION) throw new Error('Unsupported workflow database schema.');
      }).immediate();
      securePrivateSqliteSidecars(path);
    } catch {
      logger.warn('Workflow storage could not open.');
      this.close();
      throw unavailable();
    }
  }

  read<T>(operation: (database: Database) => T): T {
    if (!this.#database) throw unavailable();
    try {
      return operation(this.#database);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      logger.warn('Workflow storage fenced.', { errorCode: diagnosticErrorCode(error) });
      this.close();
      throw unavailable();
    }
  }

  write<T>(operation: (database: Database) => T): T {
    return this.read(db => db.transaction(() => {
      const value = operation(db);
      this.beforeCommit?.();
      return value;
    }).immediate());
  }

  close(): void {
    const db = this.#database;
    this.#database = null;
    try { db?.close(); } catch { /* Storage remains fenced. */ }
  }
}
