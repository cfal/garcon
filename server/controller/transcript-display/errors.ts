import { isErrorCode } from '../../../common/error-codes.js';
import { UNDECODABLE_LEDGER_ROW } from '../ledger/errors.js';

export function displayErrorCode(error: unknown): string {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (code === 'SQLITE_FULL' || code === 'ENOSPC') return 'DISPLAY_DISK_FULL';
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) return 'DISPLAY_BUSY';
  if (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB') return 'DISPLAY_STORE_INVALID';
  return isErrorCode(code) || code === UNDECODABLE_LEDGER_ROW ? code : 'DISPLAY_INDEX_FAILED';
}

export function transientDisplayFailure(code: string): boolean {
  return code === 'DISPLAY_BUSY' || code === 'DISPLAY_TIMEOUT' || code === 'DISPLAY_UNAVAILABLE';
}

export function invalidDisplayStore(message: string): Error {
  return Object.assign(new Error(message), { code: 'DISPLAY_STORE_INVALID' });
}
