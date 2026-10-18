import { expect, test } from 'bun:test';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, normalizePullRequestReviewSettings, parseReviewedCommit, renderPullRequestReviewPrompt } from '../pull-request-reviews.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';

test.each([
  ['a plain line', `Findings\n\nReviewed commit: ${SHA}`, SHA],
  ['formatting and a trailing period', `**Reviewed commit:** \`${SHA}\`.`, SHA],
  ['the same commit twice', `Reviewed commit: ${SHA}\nReviewed commit: ${SHA}`, SHA],
  ['two different commits', `Reviewed commit: ${SHA}\nReviewed commit: ${'f'.repeat(40)}`, null],
  ['an abbreviated commit', 'Reviewed commit: 0123456', null],
  ['no commit line', 'No findings.', null],
])('parses the reviewed commit from %s', (_name, review, expected) => {
  expect(parseReviewedCommit(review)).toBe(expected);
});

test('renders the built-in prompt when the template is blank', () => {
  const prompt = renderPullRequestReviewPrompt('  ', { repository: 'o/r', repositoryUrl: 'https://github.com/o/r', number: 12, projectPath: '/work/r' });
  expect(prompt).toContain('Review o/r#12 comprehensively.');
  expect(prompt).toContain('Perform all work in exactly: /work/r');
});

test('pins built-in code links to the connected Enterprise repository', () => {
  const prompt = renderPullRequestReviewPrompt('', {
    repository: 'o/r', repositoryUrl: 'https://git.example.invalid/o/r', number: 12, projectPath: '/work/r',
  });
  expect(prompt).toContain('https://git.example.invalid/o/r/blob/<full-commit-sha>/path/to/file#L10-L20');
  expect(prompt).not.toContain('github.com');
  expect(prompt).not.toContain('{{repository_url}}');
});

test('requires an explicit boolean to opt into automatic posting', () => {
  expect(normalizePullRequestReviewSettings(DEFAULT_PULL_REQUEST_REVIEW_SETTINGS)?.autoPost).toBe(false);
  expect(normalizePullRequestReviewSettings({ ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, autoPost: true })?.autoPost).toBe(true);
  for (const autoPost of [undefined, null, 'true', 1]) {
    expect(normalizePullRequestReviewSettings({ ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, autoPost })).toBeNull();
  }
});

test('normalizes repository filters without bot or fork preferences', () => {
  const filters = {
    skipDrafts: true,
    trustedAuthorsOnly: true,
    baseBranches: [],
    includeLabels: [],
    excludeLabels: [],
    maxChangedLines: 5_000,
  };
  expect(normalizePullRequestReviewSettings({ ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, filters })?.filters).toEqual(filters);
});
