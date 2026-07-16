import { describe, expect, it } from 'bun:test';
import { isTranscriptSearchStorageFailure } from '../storage-error.js';

describe('transcript search storage error classification', () => {
  it('classifies scratch disk exhaustion as storage failure', () => {
    expect(isTranscriptSearchStorageFailure({ code: 'SQLITE_FULL' })).toBe(true);
    expect(isTranscriptSearchStorageFailure({ code: 'SQLITE_IOERR_WRITE' })).toBe(true);
    expect(isTranscriptSearchStorageFailure({ code: 'ENOSPC' })).toBe(true);
  });

  it('does not reinterpret provider data errors as storage failures', () => {
    expect(isTranscriptSearchStorageFailure({ code: 'SQLITE_CORRUPT' })).toBe(false);
    expect(isTranscriptSearchStorageFailure(new Error('source changed'))).toBe(false);
  });
});
