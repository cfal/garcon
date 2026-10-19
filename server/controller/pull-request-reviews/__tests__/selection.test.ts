import { expect, test } from 'bun:test';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS } from '../../../../common/pull-request-reviews.js';
import type { PullRequestSummary } from '../../../../common/gh.js';
import { decideAutoReview } from '../selection.js';
import type { ReviewSelectionHistory } from '../store.js';

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

const history = (overrides: Partial<ReviewSelectionHistory> = {}): ReviewSelectionHistory => ({ active: false, completed: false, stopped: false, attempts: 0, ...overrides });

const settings = { ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, autoReview: true };
const settled = { headObservedAt: NOW - 10 * 60_000, startedInLastDay: 0, now: NOW };

test.each([
  ['reviews a stable head of a trusted author', pull(), history(), { kind: 'review' }],
  ['waits while pushes may still arrive', pull(), history(), { kind: 'wait' }, { headObservedAt: NOW - 60_000 }],
  ['skips drafts', pull({ isDraft: true }), history(), { kind: 'skip', reason: 'draft' }],
  ['reviews bot authors under the same rules as other authors', pull({ authorIsBot: true }), history(), { kind: 'review' }],
  ['applies the author trust filter to bots', pull({ authorIsBot: true, authorAssociation: 'none' }), history(), { kind: 'skip', reason: 'untrusted-author' }],
  ['skips outside contributors', pull({ authorAssociation: 'contributor' }), history(), { kind: 'skip', reason: 'untrusted-author' }],
  ['trusts the viewer', pull({ authorAssociation: 'none', authoredByViewer: true }), history(), { kind: 'review' }],
  ['skips forks', pull({ isCrossRepository: true }), history(), { kind: 'skip', reason: 'fork' }],
  ['skips oversized changes', pull({ additions: 6_000 }), history(), { kind: 'skip', reason: 'too-large' }],
  ['settles a reviewed head', pull(), history({ completed: true }), { kind: 'settled' }],
  ['settles a head under review', pull(), history({ active: true }), { kind: 'settled' }],
  ['waits for a queued review after a push', pull(), history({ active: true }), { kind: 'settled' }],
  ['waits for a running review after a push', pull(), history({ active: true }), { kind: 'settled' }],
  ['waits for a permission answer after a push', pull(), history({ active: true }), { kind: 'settled' }],
  ['reviews again after the head moves', pull(), history(), { kind: 'review' }],
  ['respects a user stop', pull(), history({ stopped: true }), { kind: 'skip', reason: 'stopped' }],
  ['stops retrying after the attempt limit', pull(), history({ attempts: 2 }), { kind: 'skip', reason: 'attempts-exhausted' }],
  ['respects the daily limit', pull(), history(), { kind: 'skip', reason: 'daily-limit' }, { startedInLastDay: 20 }],
] as const)('%s', (_name, subject, history, expected, overrides = {}) => {
  expect(decideAutoReview({ settings, pull: subject, history, ...settled, ...overrides })).toEqual(expected);
});

test('only reviews requested pull requests when configured to', () => {
  const requestedOnly = { ...settings, onlyWhenReviewRequested: true };
  expect(decideAutoReview({ settings: requestedOnly, pull: pull(), history: history(), ...settled })).toEqual({ kind: 'skip', reason: 'review-not-requested' });
  expect(decideAutoReview({ settings: requestedOnly, pull: pull({ reviewRequest: 'team' }), history: history(), ...settled })).toEqual({ kind: 'review' });
});
