import { describe, expect, test } from 'bun:test';
import {
  MAX_FILE_REVISION_LENGTH,
  isFileRevision,
  parseFileRevisionResponse,
  parseReadTextResponse,
  parseSaveTextRequest,
  parseSaveTextResponse,
} from '../file-contracts.js';

describe('file revision metadata', () => {
  test.each([
    ['v1:synthetic_revision-1', true],
    [`v1:${'a'.repeat(MAX_FILE_REVISION_LENGTH - 3)}`, true],
    [`v1:${'a'.repeat(MAX_FILE_REVISION_LENGTH - 2)}`, false],
    ['v1:', false],
    ['v1:invalid revision', false],
    ['v1:\u00e9', false],
    [null, false],
  ])('validates a bounded ASCII revision (%#)', (revision, valid) => {
    expect(isFileRevision(revision)).toBe(valid);
    expect(parseFileRevisionResponse({ status: 'ready', revision }) !== null).toBe(valid);
    expect(parseReadTextResponse({ content: 'text', path: '/project/file.txt', revision }) !== null).toBe(valid);
    expect(parseSaveTextResponse({ success: true, path: '/project/file.txt', message: 'Saved', revision }) !== null).toBe(valid);
    for (const conflictResolution of ['reject', 'overwrite']) {
      expect(parseSaveTextRequest({ content: 'text', expectedRevision: revision, conflictResolution }) !== null).toBe(valid);
    }
  });
});
