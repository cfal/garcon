import { describe, expect, test } from 'bun:test';
import {
  MAX_DIRECTORY_NAME_BYTES,
  MAX_FILE_REVISION_LENGTH,
  directoryNameProblem,
  isFileRevision,
  parseCreateDirectoryRequest,
  parseDirectoryEntry,
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

describe('directory creation contract', () => {
  test.each([
    ['project', null],
    ['.hidden', null],
    ['with space', null],
    ['é'.repeat(127) + 'x', null],
    [' padded ', null],
    ['', 'empty'],
    ['.', 'reserved'],
    ['..', 'reserved'],
    ['a/b', 'invalid-character'],
    ['a\\b', 'invalid-character'],
    ['line\nbreak', 'invalid-character'],
    ['nul\0byte', 'invalid-character'],
    ['delete\u007f', 'invalid-character'],
    ['x'.repeat(MAX_DIRECTORY_NAME_BYTES + 1), 'too-long'],
    ['é'.repeat(128), 'too-long'],
  ])('classifies a directory name (%#)', (name, problem) => {
    expect(directoryNameProblem(name)).toBe(problem);
  });

  test('parses only typed requests and created directories', () => {
    expect(parseCreateDirectoryRequest({ name: 'project', ignored: true })).toEqual({ name: 'project' });
    for (const value of [null, [], {}, { name: 7 }, 'project']) expect(parseCreateDirectoryRequest(value)).toBeNull();
    const created = { name: 'project', path: '/base/project', type: 'directory' };
    expect(parseDirectoryEntry({ ...created, ignored: true })).toEqual(created);
    for (const value of [null, { ...created, type: 'file' }, { ...created, path: '' }, { ...created, name: '' }, { name: 'project' }]) {
      expect(parseDirectoryEntry(value)).toBeNull();
    }
  });
});
