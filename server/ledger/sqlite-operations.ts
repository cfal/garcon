import { Database } from 'bun:sqlite';

export function nextOrdinal(db: Database, viewId: string): number {
  return runQuery(() => {
    const row = db.query<{ maximum: number | null }, [string]>(`
      SELECT max(ordinal) AS maximum FROM transcript_rows WHERE view_id = ?
    `).get(viewId);
    return (row?.maximum ?? 0) + 1;
  });
}

export function runTransaction<T>(db: Database, work: () => T): T {
  try {
    db.exec('BEGIN IMMEDIATE');
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    const failure = asError(error);
    if (db.inTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        Object.defineProperty(failure, ROLLBACK_FAILURE_PROPERTY, {
          configurable: true,
          value: asError(rollbackError),
        });
      }
    }
    throw failure;
  }
}

const ROLLBACK_FAILURE_PROPERTY = 'rollbackFailure';
const QUERY_FAILURE_PROPERTY = 'ledgerQueryFailure';

interface TransactionFailure extends Error {
  readonly rollbackFailure?: Error;
}

interface QueryFailure extends Error {
  readonly ledgerQueryFailure?: boolean;
}

export function getTransactionRollbackFailure(error: unknown): Error | null {
  if (!(error instanceof Error)) return null;
  const rollbackFailure = (error as TransactionFailure)[ROLLBACK_FAILURE_PROPERTY];
  return rollbackFailure instanceof Error ? rollbackFailure : null;
}

export function runQuery<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    const failure = asError(error);
    Object.defineProperty(failure, QUERY_FAILURE_PROPERTY, {
      configurable: true,
      value: true,
    });
    throw failure;
  }
}

export function isQueryFailure(error: unknown): boolean {
  return error instanceof Error && (error as QueryFailure)[QUERY_FAILURE_PROPERTY] === true;
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
