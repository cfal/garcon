import { expect, test } from 'bun:test';
import { PULL_REQUEST_FINGERPRINT_FIELDS, type PullRequestFingerprint, type PullRequestSummary } from '../../../../common/gh.js';
import { fingerprintBatches, planFingerprintRefresh } from '../fingerprints.js';

const summary: PullRequestSummary = {
  number: 7, title: 'Synthetic change', state: 'open', isDraft: false, author: 'author', headRefName: 'feature',
  baseRefName: 'main', additions: 1, deletions: 1, changedFiles: 1, createdAt: '', updatedAt: '2026-03-01T00:00:00Z', url: '',
  reviewDecision: null, checksState: 'pending', mergeable: 'unknown',
  headRefOid: 'a'.repeat(40), baseRefOid: 'e'.repeat(40), reviewCount: 0, reviewThreadCount: 0, isCrossRepository: false,
  authorAssociation: 'member', authorIsBot: false, authoredByViewer: false, labels: ['bug'], reviewRequest: 'team',
};
const saved = { pulls: [summary], viewerLogin: 'viewer', nameWithOwner: 'acme/app', url: 'https://github.com/acme/app' };
const repo = { nameWithOwner: 'acme/app', url: 'https://github.com/acme/app' };

function fingerprint(change: Partial<PullRequestFingerprint> = {}): PullRequestFingerprint {
  return { ...Object.fromEntries(PULL_REQUEST_FINGERPRINT_FIELDS.map((field) => [field, summary[field]])) as PullRequestFingerprint, ...change };
}

test('unchanged fingerprints need no read', () => {
  expect(planFingerprintRefresh(saved, 'viewer', { kind: 'read', repo, pulls: [fingerprint()] })).toEqual({ kind: 'unchanged' });
});

for (const change of [
  { checksState: 'passing' },
  { reviewDecision: 'approved' },
  { mergeable: 'conflicting' },
] as Partial<PullRequestFingerprint>[]) {
  test(`applies ${Object.keys(change).join(', ')} without a full read and keeps the other summary fields`, () => {
    const plan = planFingerprintRefresh(saved, 'viewer', { kind: 'read', repo, pulls: [fingerprint(change)] });
    expect(plan).toEqual({ kind: 'apply', pulls: [{ ...summary, ...change }] });
  });
}

for (const change of [
  { updatedAt: '2026-03-01T00:05:00Z' }, { headRefOid: 'b'.repeat(40) }, { baseRefOid: 'f'.repeat(40) },
  { isDraft: true }, { reviewCount: 1 }, { reviewThreadCount: 1 }, { number: 8 },
] as Partial<PullRequestFingerprint>[]) {
  test(`reads in full after a change to ${Object.keys(change).join(', ')}`, () => {
    expect(planFingerprintRefresh(saved, 'viewer', { kind: 'read', repo, pulls: [fingerprint(change)] })).toEqual({ kind: 'full-read' });
  });
}

test('reads in full when the set of open pull requests, the account, or the repository changed', () => {
  const read = { kind: 'read' as const, repo, pulls: [fingerprint()] };
  expect(planFingerprintRefresh(saved, 'viewer', { ...read, pulls: [] })).toEqual({ kind: 'full-read' });
  expect(planFingerprintRefresh(saved, 'viewer', { ...read, pulls: [fingerprint(), fingerprint({ number: 8 })] })).toEqual({ kind: 'full-read' });
  expect(planFingerprintRefresh(saved, 'other-viewer', read)).toEqual({ kind: 'full-read' });
  expect(planFingerprintRefresh(saved, 'viewer', { ...read, repo: { ...repo, nameWithOwner: 'Acme/App' } })).toEqual({ kind: 'full-read' });
});

test('a saved summary without fingerprint fields reads in full', () => {
  const { reviewCount: _reviews, ...legacy } = summary;
  expect(planFingerprintRefresh({ ...saved, pulls: [legacy as PullRequestSummary] }, 'viewer', { kind: 'read', repo, pulls: [fingerprint()] }))
    .toEqual({ kind: 'full-read' });
});

test('a repository the batch could not read, or read only in part, is read in full', () => {
  expect(planFingerprintRefresh(saved, 'viewer', { kind: 'incomplete' })).toEqual({ kind: 'full-read' });
  expect(planFingerprintRefresh(saved, 'viewer', { kind: 'failed', reason: 'not-found', message: 'Not found' })).toEqual({ kind: 'full-read' });
});

test('batches by executor and host, in order, at the batch size', () => {
  const candidate = (executorId: string, host: string, index: number) => ({ executorId, identity: { host, nameWithOwner: `acme/app-${index}` }, index });
  const candidates = [
    ...Array.from({ length: 27 }, (_, index) => candidate('local', 'github.com', index)),
    candidate('remote', 'github.com', 100),
    candidate('local', 'GHE.example.invalid', 101),
    candidate('local', 'ghe.example.invalid', 102),
  ];
  const batches = fingerprintBatches(candidates);
  expect(batches.map((batch) => batch.map((entry) => entry.index))).toEqual([
    Array.from({ length: 25 }, (_, index) => index), [25, 26], [100], [101, 102],
  ]);
  expect(fingerprintBatches(candidates.slice(0, 5), 2).map((batch) => batch.length)).toEqual([2, 2, 1]);
});
