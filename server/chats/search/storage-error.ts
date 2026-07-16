const STORAGE_ERROR_CODES = new Set([
  'EDQUOT',
  'EIO',
  'ENOMEM',
  'ENOSPC',
  'SQLITE_CANTOPEN',
  'SQLITE_FULL',
  'SQLITE_IOERR',
  'SQLITE_NOMEM',
  'SQLITE_READONLY',
]);

export function isTranscriptSearchStorageFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? error.code : undefined;
  if (typeof code !== 'string') return false;
  return STORAGE_ERROR_CODES.has(code)
    || [...STORAGE_ERROR_CODES].some((prefix) => code.startsWith(`${prefix}_`));
}
