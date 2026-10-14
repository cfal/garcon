import { expect, test } from 'bun:test';
import { parseReviewedCommit, renderPullRequestReviewPrompt } from '../pull-request-reviews.ts';

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
  const prompt = renderPullRequestReviewPrompt('  ', { repository: 'o/r', number: 12, projectPath: '/work/r' });
  expect(prompt).toContain('Review o/r#12 comprehensively.');
  expect(prompt).toContain('Perform all work in exactly: /work/r');
});
