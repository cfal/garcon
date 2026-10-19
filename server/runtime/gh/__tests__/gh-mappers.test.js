import { describe, it, expect } from 'bun:test';
import {
  buildPatchFileSet,
  buildPullRequestList,
  buildReviewTarget,
  buildThreads,
  mapMergeable,
  mapReviewDecision,
  mapSummary,
} from '../gh-mappers.js';

const rawPull = {
  number: 42,
  title: 'Add feature',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'author-one', __typename: 'User' },
  authorAssociation: 'COLLABORATOR',
  headRefName: 'feat/x',
  baseRefName: 'main',
  headRefOid: 'a'.repeat(40),
  isCrossRepository: true,
  additions: 10,
  deletions: 3,
  changedFiles: 2,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-02T00:00:00Z',
  url: 'https://git.example.invalid/o/r/pull/42',
  reviewDecision: 'CHANGES_REQUESTED',
  labels: { nodes: [{ name: 'bug' }, null] },
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'viewer-one' } }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
};

describe('mapSummary', () => {
  it('maps the review inputs of an open pull request', () => {
    expect(mapSummary(rawPull, 'viewer-one', new Set([42]))).toMatchObject({
      number: 42,
      state: 'open',
      author: 'author-one',
      authorAssociation: 'collaborator',
      authorIsBot: false,
      authoredByViewer: false,
      headRefOid: 'a'.repeat(40),
      isCrossRepository: true,
      labels: ['bug'],
      reviewDecision: 'changes_requested',
      checksState: 'failing',
      reviewRequest: 'me',
    });
  });

  it('attributes a request the viewer only matches through search to a team', () => {
    const viaTeam = { ...rawPull, reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team' } }] } };
    expect(mapSummary(viaTeam, 'viewer-one', new Set([42])).reviewRequest).toBe('team');
    expect(mapSummary(viaTeam, 'viewer-one', new Set()).reviewRequest).toBe(null);
  });

  it('treats unknown associations as untrusted and recognizes bots and the viewer', () => {
    const summary = mapSummary({ number: 1, author: { login: 'viewer-one', __typename: 'Bot' }, authorAssociation: 'NEW_KIND' }, 'viewer-one', new Set());
    expect(summary).toMatchObject({ authorAssociation: 'none', authorIsBot: true, authoredByViewer: true, checksState: 'none' });
  });
});

describe('buildPullRequestList', () => {
  it('carries the repository and the acting login', () => {
    const list = buildPullRequestList({ data: {
      viewer: { login: 'viewer-one' },
      repository: { nameWithOwner: 'o/r', url: 'https://git.example.invalid/o/r', pullRequests: { nodes: [rawPull] } },
      requested: { nodes: [{ number: 42 }] },
    } });
    expect(list.repo).toEqual({ nameWithOwner: 'o/r', url: 'https://git.example.invalid/o/r' });
    expect(list.viewerLogin).toBe('viewer-one');
    expect(list.pulls.map((pull) => [pull.number, pull.reviewRequest])).toEqual([[42, 'me']]);
  });

  it('rejects a response without a repository', () => {
    expect(() => buildPullRequestList({ data: { viewer: { login: 'viewer-one' }, repository: null } })).toThrow();
  });
});

describe('buildReviewTarget', () => {
  const actor = { id: "actor:viewer", login: "viewer" };
  const other = { id: "actor:other", login: "other" };
  const comment = (id, body, overrides = {}) => ({ author: actor, id, url: `https://git.example.invalid/c/${id}`, isMinimized: false, viewerDidAuthor: true, body, ...overrides });
  const raw = (comments) => ({ data: { viewer: actor, repository: { nameWithOwner: "o/r", url: "https://git.example.invalid/o/r", pullRequest: { number: 7, state: 'OPEN', headRefOid: 'b'.repeat(40), comments: { nodes: comments } } } } });

  it('returns marked comments with their stable authors across account switches', () => {
    const target = buildReviewTarget(raw([
      comment('one', 'Review\n<!-- garcon-review o/r#7 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->'),
      comment('two', 'Unrelated <!-- other -->'),
      comment('three', '<!-- garcon-review o/r#7 dddddddddddddddddddddddddddddddddddddddd -->', { author: other }),
      comment('four', '<!-- garcon-review o/r#7 dddddddddddddddddddddddddddddddddddddddd -->', { isMinimized: true }),
    ]), 'garcon-review o/r#7 ');
    expect(target).toMatchObject({ number: 7, state: 'open', headRefOid: 'b'.repeat(40) });
    expect(target.markedComments).toEqual([
      { author: actor, id: 'one', url: 'https://git.example.invalid/c/one', marker: '<!-- garcon-review o/r#7 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->', isMinimized: false },
      { author: other, id: 'three', url: 'https://git.example.invalid/c/three', marker: '<!-- garcon-review o/r#7 dddddddddddddddddddddddddddddddddddddddd -->', isMinimized: false },
      { author: actor, id: 'four', url: 'https://git.example.invalid/c/four', marker: '<!-- garcon-review o/r#7 dddddddddddddddddddddddddddddddddddddddd -->', isMinimized: true },
    ]);
  });

  it('matches the marker prefix literally', () => {
    const target = buildReviewTarget(raw([comment('one', '<!-- garcon-review oXr#7 abc -->')]), 'garcon-review o.r#7 ');
    expect(target.markedComments).toEqual([]);
  });

  it('uses the final canonical marker rather than quoted or malformed markers', () => {
    const canonical = '<!-- garcon-review o/r#7 '+ 'b'.repeat(40) +' -->';
    const target = buildReviewTarget(raw([
      comment('one', '<!-- garcon-review o/r#7 '+ 'a'.repeat(40) +' -->\nQuoted text\n' + canonical + '\n'),
      comment('two', '<!-- garcon-review o/r#7 abc -->'),
      comment('three', canonical + '\nAgent text after the marker'),
    ]), 'garcon-review o/r#7 ');
    expect(target.markedComments).toMatchObject([{ id: 'one', marker: canonical }]);
  });

  it('reports a missing pull request', () => {
    expect(buildReviewTarget({ data: { repository: { pullRequest: null } } }, 'x')).toBe(null);
  });

  it('recognizes full SHA-256 markers across a repository casing change', () => {
    const marker = `<!-- garcon-review Acme/App#7 ${'c'.repeat(64)} -->`;
    const target = buildReviewTarget(raw([comment('sha256', marker)]), 'garcon-review acme/app#7 ');
    expect(target.markedComments).toMatchObject([{ id: 'sha256', marker }]);
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

describe('buildPatchFileSet', () => {
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
        renderedRowCount: 0,
        patchBytes: 0,
        patch: '',
      },
    },
  ];

  it('prefers GitHub per-file line counts and exposes bodies by path', () => {
    const set = buildPatchFileSet(rendered, [{ path: 'x.ts', additions: 5, deletions: 3 }]);
    expect(set.files[0].additions).toBe(5);
    expect(set.files[0].deletions).toBe(3);
    expect(set.files[0].workTreeStatus).toBe('M');
    expect(set.fileBodies['x.ts'].bodyFingerprint).toBe('fp-x');
  });

  it('falls back to rendered counts when GitHub file data is missing', () => {
    const set = buildPatchFileSet(rendered, undefined);
    expect(set.files[0].additions).toBe(1);
    expect(set.files[0].deletions).toBe(1);
  });
});
