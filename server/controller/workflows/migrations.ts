import type { Database } from 'bun:sqlite';
import { WORKFLOW_SCHEMA, WORKFLOW_SCHEMA_VERSION } from './schema.js';

export function validateWorkflowDatabase(database: Database): void {
  if (database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version !== WORKFLOW_SCHEMA_VERSION) {
    throw new Error('Unsupported workflow schema.');
  }
  const expected = WORKFLOW_SCHEMA.filter(sql => sql.startsWith('CREATE ')).toSorted();
  const actual = database.query<{ sql: string }, []>("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().map(row => row.sql.trim()).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Invalid workflow schema.');
  if (database.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') throw new Error('Workflow integrity check failed.');
  if (database.query('PRAGMA foreign_key_check').get()) throw new Error('Invalid workflow references.');
  const meta = database.query<{ store_id: string; revision: number; admission_epoch: number }, []>('SELECT * FROM workflow_metadata WHERE singleton=1').get();
  if (!meta?.store_id || !Number.isSafeInteger(meta.revision) || !Number.isSafeInteger(meta.admission_epoch)) throw new Error('Invalid workflow metadata.');
}

export function initializeWorkflowDatabase(database: Database): void {
  const version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
  if (version === 0) {
    if (database.query("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new Error('Refusing to replace unrecognized workflow data.');
    database.transaction(() => {
      database.exec(WORKFLOW_SCHEMA.join(';\n'));
      database.query('INSERT INTO workflow_metadata VALUES (1,?,0,0)').run(crypto.randomUUID());
    }).immediate();
  }
  validateWorkflowDatabase(database);
}
