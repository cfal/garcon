import { describe, it, expect } from 'bun:test';
import {
  buildRenderedFileSet,
  buildThreads,
  mapChecksState,
  mapMergeable,
  mapReviewDecision,
  mapSummary,
} from '../gh-mappers.js';

describe('mapSummary', () => {
  it('maps a raw open PR with a failing check', () => {
    const summary = mapSummary({
      number: 42,
      title: 'Add feature',
      state: 'OPEN',
      isDraft: false,
      author: { login: 'octocat' },
      headRefName: 'feat/x',
      baseRefName: 'main',
      additions: 10,
      deletions: 3,
      changedFiles: 2,
      updatedAt: '2024-01-01T00:00:00Z',
      url: 'https://github.com/o/r/pull/42',
      reviewDecision: 'CHANGES_REQUESTED',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'ci' }],
    });

    expect(summary.number).toBe(42);
    expect(summary.state).toBe('open');
    expect(summary.author).toBe('octocat');
    expect(summary.reviewDecision).toBe('changes_requested');
    expect(summary.checksState).toBe('failing');
  });

  it('keeps draft PRs in the open state', () => {
    const summary = mapSummary({ number: 1, isDraft: true, state: 'OPEN' });
    expect(summary.isDraft).toBe(true);
    expect(summary.state).toBe('open');
  });
});

describe('mapChecksState', () => {
  it('returns none for empty rollups', () => {
    expect(mapChecksState([])).toBe('none');
    expect(mapChecksState(null)).toBe('none');
  });

  it('prioritizes failing over pending', () => {
    expect(
      mapChecksState([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'IN_PROGRESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
    ).toBe('failing');
  });

  it('returns pending when a check is still running', () => {
    expect(
      mapChecksState([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'QUEUED' },
      ]),
    ).toBe('pending');
  });

  it('returns passing when all checks succeed', () => {
    expect(
      mapChecksState([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { state: 'SUCCESS' },
      ]),
    ).toBe('passing');
  });
});

describe('mapReviewDecision / mapMergeable', () => {
  it('maps review decisions to lowercase enums', () => {
    expect(mapReviewDecision('APPROVED')).toBe('approved');
    expect(mapReviewDecision('')).toBe(null);
    expect(mapReviewDecision(undefined)).toBe(null);
  });

  it('maps mergeability', () => {
    expect(mapMergeable('MERGEABLE')).toBe('mergeable');
    expect(mapMergeable('CONFLICTING')).toBe('conflicting');
    expect(mapMergeable('UNKNOWN')).toBe('unknown');
  });
});

describe('buildThreads', () => {
  const comments = [
    {
      id: 1,
      path: 'a.ts',
      body: 'root comment',
      user: { login: 'alice' },
      created_at: '2024-01-01T00:00:00Z',
      line: 10,
      side: 'RIGHT',
      diff_hunk: '@@ -1 +1 @@',
    },
    {
      id: 2,
      path: 'a.ts',
      body: 'a reply',
      user: { login: 'bob' },
      created_at: '2024-01-01T01:00:00Z',
      in_reply_to_id: 1,
      line: 10,
      side: 'RIGHT',
    },
    {
      id: 3,
      path: 'b.ts',
      body: 'outdated note',
      user: { login: 'carol' },
      created_at: '2024-01-02T00:00:00Z',
      line: null,
      original_line: 5,
      side: 'LEFT',
      diff_hunk: '@@ -5 +5 @@',
    },
  ];

  it('groups replies under their root comment', () => {
    const threads = buildThreads(comments);
    expect(threads).toHaveLength(2);
    const rootThread = threads.find((thread) => thread.id === '1');
    expect(rootThread.comments).toHaveLength(2);
    expect(rootThread.comments[0].author).toBe('alice');
    expect(rootThread.comments[1].author).toBe('bob');
    expect(rootThread.side).toBe('after');
    expect(rootThread.line).toBe(10);
    expect(rootThread.isOutdated).toBe(false);
  });

  it('marks comments with a null line as outdated and left-side as before', () => {
    const threads = buildThreads(comments);
    const outdated = threads.find((thread) => thread.id === '3');
    expect(outdated.isOutdated).toBe(true);
    expect(outdated.side).toBe('before');
    expect(outdated.line).toBe(5);
  });

  it('sorts threads by path then line', () => {
    const threads = buildThreads(comments);
    expect(threads.map((thread) => thread.path)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('buildRenderedFileSet', () => {
  const rendered = [
    {
      path: 'x.ts',
      status: 'M',
      changeKind: 'modified',
      additions: 1,
      deletions: 1,
      isBinary: false,
      body: {
        path: 'x.ts',
        bodyFingerprint: 'fp-x',
        bodyState: 'loaded',
        category: 'normal',
        isBinary: false,
        isTooLarge: false,
        rows: [],
        hunks: [],
      },
    },
  ];

  it('prefers GitHub per-file line counts and exposes bodies by path', () => {
    const set = buildRenderedFileSet(rendered, [{ path: 'x.ts', additions: 5, deletions: 3 }]);
    expect(set.files[0].additions).toBe(5);
    expect(set.files[0].deletions).toBe(3);
    expect(set.files[0].workTreeStatus).toBe('M');
    expect(set.fileBodies['x.ts'].bodyFingerprint).toBe('fp-x');
  });

  it('falls back to rendered counts when GitHub file data is missing', () => {
    const set = buildRenderedFileSet(rendered, undefined);
    expect(set.files[0].additions).toBe(1);
    expect(set.files[0].deletions).toBe(1);
  });
});
