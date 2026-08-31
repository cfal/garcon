import type { Database } from 'bun:sqlite';
import { LedgerError, LedgerFencedError } from './errors.js';
import {
  asError,
  getTransactionRollbackFailure,
  isQueryFailure,
} from './sqlite-operations.js';

interface LedgerConnection {
  readonly db: Database;
}

export class LedgerFailureFences<Entry extends LedgerConnection> {
  readonly #readFailures = new Map<string, Error>();
  readonly #writeFailures = new Map<string, Error>();

  hasReadFailure(chatId: string): boolean {
    return this.#readFailures.has(chatId);
  }

  read<T>(chatId: string, available: () => Entry, work: (entry: Entry) => T): T {
    const readFailure = this.#readFailures.get(chatId);
    if (readFailure) throw new LedgerFencedError(chatId, { cause: readFailure });
    const entry = available();
    try {
      return work(entry);
    } catch (error) {
      if (isDomainError(error) && !isQueryFailure(error)) throw error;
      const failure = asError(error);
      this.#readFailures.set(chatId, failure);
      throw new LedgerFencedError(chatId, { cause: failure });
    }
  }

  write<T>(
    chatId: string,
    available: () => Entry,
    work: (entry: Entry) => T,
    rehydrate: (entry: Entry) => void,
  ): T {
    const readFailure = this.#readFailures.get(chatId);
    if (readFailure) throw new LedgerFencedError(chatId, { cause: readFailure });
    const writeFailure = this.#writeFailures.get(chatId);
    if (writeFailure) throw new LedgerFencedError(chatId, { cause: writeFailure });
    const entry = available();
    try {
      return work(entry);
    } catch (error) {
      const failure = asError(error);
      const rollbackFailure = getTransactionRollbackFailure(failure);
      const readUnsafe = isReadUnsafeFailure(failure) || isReadUnsafeFailure(rollbackFailure);
      if (isDomainError(error)
          && !readUnsafe
          && !rollbackFailure
          && !entry.db.inTransaction) throw error;
      this.#writeFailures.set(chatId, failure);
      if (readUnsafe || entry.db.inTransaction) this.#readFailures.set(chatId, failure);
      else {
        try {
          rehydrate(entry);
        } catch (rehydrationError) {
          this.#readFailures.set(chatId, asError(rehydrationError));
        }
      }
      throw new LedgerFencedError(chatId, { cause: failure });
    }
  }

  delete(chatId: string): void {
    this.#readFailures.delete(chatId);
    this.#writeFailures.delete(chatId);
  }

  clear(): void {
    this.#readFailures.clear();
    this.#writeFailures.clear();
  }
}

function isReadUnsafeFailure(error: Error | null): boolean {
  return error !== null && (isQueryFailure(error) || isSqliteCorruptionFailure(error));
}

function isSqliteCorruptionFailure(error: Error): boolean {
  const code = (error as Error & { readonly code?: unknown }).code;
  return typeof code === 'string'
    && (code === 'SQLITE_CORRUPT' || code.startsWith('SQLITE_CORRUPT_'));
}

function isDomainError(error: unknown): error is LedgerError | TypeError {
  return error instanceof LedgerError || error instanceof TypeError;
}
