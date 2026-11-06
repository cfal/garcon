import type { Database } from 'bun:sqlite';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError } from '../../common/domain-error.js';
import { configureDurableSqlite, openPrivateSqliteDatabase, openPrivateSqliteReadOnly, securePrivateSqliteSidecars } from '../lib/private-sqlite.js';
import { workflowUnavailable } from './errors.js';
import { initializeWorkflowDatabase, validateWorkflowDatabase } from './migrations.js';
import { workflowProviderReferences } from './references.js';

export class WorkflowStore {
  #database: Database | null = null;
  constructor(workspaceDir: string, private readonly beforeCommit?: () => void) {
    const path = join(workspaceDir, 'workflows.sqlite');
    try {
      this.#database = openPrivateSqliteDatabase(path);
      initializeWorkflowDatabase(this.#database);
      configureDurableSqlite(this.#database);
      securePrivateSqliteSidecars(path);
    } catch { this.close(); throw workflowUnavailable(); }
  }
  read<T>(operation: (database: Database) => T): T {
    if (!this.#database) throw workflowUnavailable();
    try { return operation(this.#database); }
    catch (error) {
      if (error instanceof DomainError) throw error;
      this.close();
      throw workflowUnavailable();
    }
  }
  transaction<T>(operation: (database: Database) => T): T {
    return this.read(database => database.transaction(() => {
      const result = operation(database);
      if (result instanceof Promise) throw new Error('Workflow transactions must be synchronous.');
      this.beforeCommit?.();
      return result;
    }).immediate());
  }
  close(): void {
    const database = this.#database;
    this.#database = null;
    try { database?.close(); } catch { /* Storage remains fenced. */ }
  }
}

export function inspectWorkflowProviderReferences(workspaceDir: string, initialized: boolean): ReadonlySet<string> | null {
  const path = join(workspaceDir, 'workflows.sqlite');
  let database: Database | null = null;
  try {
    try { lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !initialized) return new Set();
      return null;
    }
    database = openPrivateSqliteReadOnly(path);
    validateWorkflowDatabase(database);
    return workflowProviderReferences(database);
  } catch { return null; }
  finally { database?.close(); }
}
