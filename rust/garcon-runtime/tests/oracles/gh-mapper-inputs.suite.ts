import { expect, test } from 'bun:test';
import { buildDetail, buildPatchFileSet, buildReviewTarget, mapChecks, mapMergeable, mapPrState, mapReviewDecision } from '../../../../server/runtime/gh/gh-mappers.js';
import { parseMultiFileDiffPatches } from '../../../../server/runtime/gh/pull-request-diff.js';

test('maps the state, checks, draft detail, and missing fields from gh', () => {
  const checks = [
    { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://git.example.invalid/check' },
    { context: 'check', state: 'FAILURE', targetUrl: 'https://git.example.invalid/status' },
    { status: 'IN_PROGRESS', conclusion: 'SUCCESS' },
    { conclusion: 'SKIPPED' },
    { conclusion: 'NEUTRAL' },
    { conclusion: 'new state' },
  ];
  expect(mapChecks(checks).map(check => check.state)).toEqual(['success', 'failure', 'pending', 'skipped', 'neutral', 'neutral']);
  expect(mapChecks(null)).toEqual([]);
  expect(mapPrState('merged')).toBe('merged');
  expect(mapPrState('CLOSED')).toBe('closed');
  expect(mapMergeable('mergeable')).toBe('mergeable');
  expect(mapReviewDecision('review_required')).toBe('review_required');
  expect(buildDetail({
    number: 42, body: 'synthetic', author: { name: 'Test User' }, state: 'CLOSED', isDraft: true, statusCheckRollup: checks,
  }, [], [])).toMatchObject({ number: 42, author: 'Test User', state: 'open', changedFiles: 0 });
});

test('passes through author and viewer identities in the response property order', () => {
  const viewer = { login: 'viewer', id: 'actor:viewer' };
  const author = { login: 'reviewer', id: 'actor:reviewer' };
  const body = '<!-- garcon-review o/r#1 ' + 'a'.repeat(40) + ' -->';
  const target = buildReviewTarget({ data: {
    viewer,
    repository: {
      nameWithOwner: 'o/r', url: 'https://git.example.invalid/o/r',
      pullRequest: { number: 1, comments: { nodes: [{ id: 'one', author, body }] } },
    },
  } }, 'garcon-review ');
  expect(target?.viewer).toBe(viewer);
  expect(target?.markedComments[0]?.author).toBe(author);
});

test('observes what the original does with a path named __proto__', () => {
  const patches = parseMultiFileDiffPatches('diff --git a/__proto__ b/__proto__\n--- a/__proto__\n+++ b/__proto__\n@@ -1 +1 @@\n-old\n+new');
  const result = buildPatchFileSet(patches, undefined);
  expect(result.files[0]?.path).toBe('__proto__');
  expect(Object.hasOwn(result.fileBodies, '__proto__')).toBe(false);
});
