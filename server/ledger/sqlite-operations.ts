import { Database } from 'bun:sqlite';

export function nextOrdinal(db: Database, viewId: string): number {
  const row = db.query<{ maximum: number | null }, [string]>(`
    SELECT max(ordinal) AS maximum FROM transcript_rows WHERE view_id = ?
  `).get(viewId);
  return (row?.maximum ?? 0) + 1;
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

interface TransactionFailure extends Error {
  readonly rollbackFailure?: Error;
}

export function getTransactionRollbackFailure(error: unknown): Error | null {
  if (!(error instanceof Error)) return null;
  const rollbackFailure = (error as TransactionFailure)[ROLLBACK_FAILURE_PROPERTY];
  return rollbackFailure instanceof Error ? rollbackFailure : null;
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
