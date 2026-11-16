import { expect, test } from 'bun:test';
import { parseRemoveProjectPathRequest, parseRemoveProjectPathResponse, projectPathKey } from '../project-path-preferences.js';

const EXECUTOR = '22222222-2222-4222-8222-222222222222';

test('project removal requires an explicit owner and preserves the exact path', () => {
  for (const executorId of ['local', EXECUTOR]) {
    const input = { executorId, projectPath: '/projects/name with spaces ' };
    expect(parseRemoveProjectPathRequest(input)).toEqual(input);
  }
});

test.each([null, [], {}, { projectPath: '/project' }, { executorId: null, projectPath: '/project' },
  { executorId: 'invalid', projectPath: '/project' }, { executorId: 'local', projectPath: '  ' },
  { executorId: 'local', projectPath: 3 }, { executorId: EXECUTOR, projectPath: '/project', pinnedPaths: [] },
].map(input => ({ input })))('rejects malformed project removal: %j', ({ input }) => {
  expect(parseRemoveProjectPathRequest(input)).toBeNull();
});

test('project identity matches Windows slash aliases but preserves POSIX backslashes and whitespace', () => {
  expect(projectPathKey('D:\\projects\\atlas')).toBe(projectPathKey('D:/projects/atlas'));
  expect(projectPathKey('/projects/a\\b')).not.toBe(projectPathKey('/projects/a/b'));
  expect(projectPathKey('/projects/atlas ')).not.toBe(projectPathKey('/projects/atlas'));
});

test.each([null, {}, { success: false }, { success: true, settings: {} }, { success: true, settings: {}, unknown: true }])(
  'rejects malformed project removal response: %j', input => {
    expect(parseRemoveProjectPathResponse(input)).toBeNull();
  },
);
