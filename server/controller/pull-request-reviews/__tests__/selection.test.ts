import { expect, test } from 'bun:test';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS } from '../../../../common/pull-request-reviews.js';
import type { PullRequestSummary } from '../../../../common/gh.js';
import { decideAutoReview } from '../selection.js';
import type { StoredRun } from '../store.js';

const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-01-01T12:00:00Z');

function pull(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 7, title: 'Change', state: 'open', isDraft: false, author: 'author', headRefName: 'feature', baseRefName: 'main',
    additions: 10, deletions: 2, changedFiles: 1, createdAt: '', updatedAt: '', url: '', reviewDecision: null, checksState: 'none',
    headRefOid: HEAD, isCrossRepository: false, authorAssociation: 'member', authorIsBot: false, authoredByViewer: false,
    labels: [], reviewRequest: null, ...overrides,
  };
}

function run(overrides: Partial<StoredRun>): StoredRun {
  return {
    id: 'run', repositoryId: 'repo', number: 7, headSha: HEAD, state: 'failed', createdAt: '', title: '', reviewedSha: null,
    trigger: 'auto', message: null, chatId: null, turnId: null, startedAt: null, finishedAt: null,
    post: { status: 'none', commentUrl: null, postedAt: null, message: null }, chatArchived: false, ...overrides,
  };
}

const settings = { ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, autoReview: true };
const settled = { headObservedAt: NOW - 10 * 60_000, startedInLastDay: 0, now: NOW };

test.each([
  ['reviews a stable head of a trusted author', pull(), [], { kind: 'review' }],
  ['waits while pushes may still arrive', pull(), [], { kind: 'wait' }, { headObservedAt: NOW - 60_000 }],
  ['skips drafts', pull({ isDraft: true }), [], { kind: 'skip', reason: 'draft' }],
  ['skips bots', pull({ authorIsBot: true }), [], { kind: 'skip', reason: 'bot-author' }],
  ['skips outside contributors', pull({ authorAssociation: 'contributor' }), [], { kind: 'skip', reason: 'untrusted-author' }],
  ['trusts the viewer', pull({ authorAssociation: 'none', authoredByViewer: true }), [], { kind: 'review' }],
  ['skips forks', pull({ isCrossRepository: true }), [], { kind: 'skip', reason: 'fork' }],
  ['skips oversized changes', pull({ additions: 6_000 }), [], { kind: 'skip', reason: 'too-large' }],
  ['settles a reviewed head', pull(), [run({ state: 'completed', reviewedSha: HEAD })], { kind: 'settled' }],
  ['settles a head under review', pull(), [run({ state: 'reviewing' })], { kind: 'settled' }],
  ['reviews again after the head moves', pull(), [run({ state: 'completed', headSha: 'b'.repeat(40), reviewedSha: 'b'.repeat(40) })], { kind: 'review' }],
  ['respects a user stop', pull(), [run({ state: 'stopped' })], { kind: 'skip', reason: 'stopped' }],
  ['stops retrying after the attempt limit', pull(), [run({}), run({ id: 'two' })], { kind: 'skip', reason: 'attempts-exhausted' }],
  ['respects the daily limit', pull(), [], { kind: 'skip', reason: 'daily-limit' }, { startedInLastDay: 20 }],
] as const)('%s', (_name, subject, runs, expected, overrides = {}) => {
  expect(decideAutoReview({ settings, pull: subject, runs, ...settled, ...overrides })).toEqual(expected);
});

test('only reviews requested pull requests when configured to', () => {
  const requestedOnly = { ...settings, onlyWhenReviewRequested: true };
  expect(decideAutoReview({ settings: requestedOnly, pull: pull(), runs: [], ...settled })).toEqual({ kind: 'skip', reason: 'review-not-requested' });
  expect(decideAutoReview({ settings: requestedOnly, pull: pull({ reviewRequest: 'team' }), runs: [], ...settled })).toEqual({ kind: 'review' });
});
