import { describe, expect, test } from 'bun:test';
import { validateGhResult, validateGitResult } from '../git-result-validation.js';

const scope = { executorId: 'executor-test', instanceId: 'instance-test' };
const limits = {
  maxSummaryFiles: 10_000, maxBodyBatchFiles: 24, maxLoadedRows: 100_000,
  maxLoadedPatchBytes: 1_000_000, maxFileRows: 10_000, maxFilePatchBytes: 100_000,
  maxLineBytes: 10_000, maxContextLines: 100, bodyConcurrency: 2,
};
const baseFile = {
  path: 'example.txt', category: 'normal', additions: 1, deletions: 0, estimatedRows: 1,
  bodyState: 'unloaded', bodyFingerprint: 'fingerprint', isGenerated: false, isBinary: false, isTooLarge: false,
};
const reviewFile = { ...baseFile, indexStatus: ' ', workTreeStatus: 'M' };
const commitFile = { ...baseFile, status: 'modified', rawStatus: 'M' };
const document = { ...scope, status: 'ready', project: '/repo', documentId: 'document-test', limits, firstBodyCandidates: [] };
const revision = { kind: 'revision', requestedRevision: 'HEAD', label: 'HEAD', hash: 'a'.repeat(40), shortHash: 'aaaaaaa' };

test('comparison failures validate only the fields required by their status', () => {
  for (const result of [
    { status: 'not-found', endpoint: 'from', revision: 'missing', message: 'Not found' },
    { status: 'no-merge-base', from: revision, to: revision, message: 'No common ancestor' },
    { status: 'working-tree-changing', message: 'Try again' },
  ]) {
    const value = { ...scope, project: '/repo', ...result };
    expect(() => validateGitResult('getComparisonSnapshot', value, scope)).not.toThrow();
    for (const field of ['project', ...Object.keys(result)]) {
      expect(() => validateGitResult('getComparisonSnapshot', { ...value, [field]: undefined }, scope))
        .toThrow(expect.objectContaining({ code: 'GIT_INVALID_RESULT' }));
    }
  }
});

test('GitHub status and list results do not require detail fields', () => {
  for (const [method, result] of [
    ['getStatus', { available: true, authenticated: false, reason: 'unauthenticated' }],
    ['listPullRequests', { pulls: [], repo: null }],
  ]) {
    expect(() => validateGhResult(method, { ...scope, ...result }, scope)).not.toThrow();
    for (const field of Object.keys(result)) {
      expect(() => validateGhResult(method, { ...scope, ...result, [field]: undefined }, scope))
        .toThrow(expect.objectContaining({ code: 'GIT_INVALID_RESULT' }));
    }
  }
});

const cases = [
  {
    method: 'getWorkbenchSnapshot', file: reviewFile, statusFields: ['indexStatus', 'workTreeStatus'],
    validate: file => validateGitResult('getWorkbenchSnapshot', {
      ...document, target: { projectPath: '/repo', repoRoot: '/repo', worktreePath: '/repo', label: 'repo', branch: 'main', source: 'chat-project' },
      tree: { root: [], hasCommits: true, statsState: 'loaded' },
      reviewSummary: { ...document, mode: 'working', context: 3, files: [file] },
      selectedFile: null, snapshotId: 'snapshot-test', workbenchFingerprint: 'fingerprint',
    }, scope),
  },
  {
    method: 'getCommitSnapshot', file: commitFile, statusFields: ['status', 'rawStatus'],
    validate: file => validateGitResult('getCommitSnapshot', {
      ...document, files: [file], selectedParent: null, parentOptions: [],
      commit: { hash: revision.hash, shortHash: revision.shortHash, parents: [], author: 'Test Author',
        authorEmail: 'test@example.invalid', authorDate: '2026-01-01', committer: 'Test Author',
        committerEmail: 'test@example.invalid', committerDate: '2026-01-01', subject: 'Synthetic change', body: '', refs: [] },
    }, scope),
  },
  {
    method: 'getComparisonSnapshot', file: commitFile, statusFields: ['status', 'rawStatus'],
    validate: file => validateGitResult('getComparisonSnapshot', {
      ...document, files: [file], repoRoot: '/repo', mode: 'direct', from: revision, to: revision, effectiveFromHash: revision.hash,
    }, scope),
  },
  {
    method: 'getPullRequest', file: reviewFile, statusFields: ['indexStatus', 'workTreeStatus'],
    validate: file => validateGhResult('getPullRequest', {
      ...scope, number: 1, title: 'Synthetic change', state: 'open', isDraft: false, author: 'test',
      headRefName: 'feature', baseRefName: 'main', additions: 1, deletions: 0, changedFiles: 1,
      updatedAt: '2026-01-01', createdAt: '2026-01-01', url: 'https://git.example.invalid/pull/1',
      reviewDecision: null, body: '', mergeable: 'mergeable', files: [file], fileBodies: {}, checks: [], threads: [],
    }, scope),
  },
];

for (const { method, file, statusFields, validate } of cases) {
  describe(method, () => {
    test('accepts its own file contract without requiring the other summary status fields', () => {
      expect(() => validate(file)).not.toThrow();
      expect(() => validate({ ...file, statsKnown: false, limitReason: 'git-timeout', limitMessage: 'Timed out' })).not.toThrow();
    });
    for (const field of [...statusFields, 'isGenerated']) {
      test(`rejects missing and mistyped ${field}`, () => {
        for (const value of [undefined, null, 123]) {
          const invalid = { ...file, [field]: value };
          if (value === undefined) delete invalid[field];
          expect(() => validate(invalid)).toThrow(expect.objectContaining({ code: 'GIT_INVALID_RESULT' }));
        }
      });
    }
    test('validates optional file fields when present', () => {
      for (const invalid of [{ statsKnown: 1 }, { limitReason: 'unknown' }, { limitMessage: false }]) {
        expect(() => validate({ ...file, ...invalid })).toThrow(expect.objectContaining({ code: 'GIT_INVALID_RESULT' }));
      }
    });
    if (statusFields.includes('status')) {
      test('accepts every commit status and rejects unsupported statuses', () => {
        for (const status of ['added', 'modified', 'deleted', 'renamed', 'copied', 'type-changed', 'unknown']) {
          expect(() => validate({ ...file, status })).not.toThrow();
        }
        expect(() => validate({ ...file, status: 'M' })).toThrow(expect.objectContaining({ code: 'GIT_INVALID_RESULT' }));
      });
    }
  });
}
