import { describe, expect, it } from 'vitest';
import { buildGitReviewCommentMessage } from '../git-review-comment-message.js';
import { buildGitReviewCommentContext } from '../git-review-comment-context.js';

describe('buildGitReviewCommentMessage', () => {
	it('formats a Working Tree comparison comment with frozen line context', () => {
		const message = buildGitReviewCommentMessage({
			source: {
				kind: 'comparison',
				fromLabel: 'main',
				fromIdentity: 'abc1234',
				toLabel: 'Working Tree',
				toIdentity: 'deadbeef',
				mode: 'direct',
			},
			filePath: 'src/new.ts',
			originalPath: 'src/old.ts',
			side: 'after',
			line: 42,
			contextLines: [
				'@@ -40,3 +40,3 @@',
				' const before = true;',
				'+const answer = 42;',
			],
			body: 'Please name this value.',
			severity: 'note',
		});

		expect(message).toContain('Comparison: main (abc1234) -> Working Tree (deadbeef), direct');
		expect(message).toContain('Location: `src/old.ts -> src/new.ts`:42 (new line)');
		expect(message).toContain('```diff\n@@ -40,3 +40,3 @@');
		expect(message).toContain('+const answer = 42;');
		expect(message).toContain('Please name this value.');
	});

	it('formats a historical commit comment with its selected base', () => {
		const message = buildGitReviewCommentMessage({
			source: {
				kind: 'commit',
				shortHash: '1234567',
				subject: 'Fix parsing',
				baseLabel: 'parent 7654321',
			},
			filePath: 'parser.ts',
			side: 'before',
			line: 9,
			contextLines: ['@@ -9 +9 @@', '-old code'],
			body: 'This removal changes fallback behavior.',
			severity: 'warning',
		});

		expect(message).toContain('Comparison: parent 7654321 -> Fix parsing (1234567)');
		expect(message).toContain('Location: `parser.ts`:9 (old line)');
		expect(message).toContain('Severity: warning');
		expect(message).toContain('Comment:');
	});

	it('caps deterministic context to the hunk header and two nearby rows per side', () => {
		const rows = [
			{ key: 'h', kind: 'hunk' as const, hunkIndex: 0, hunkId: 'h0', beforeLine: null, afterLine: null, text: '@@ -1,5 +1,5 @@', diffLineIndex: -1 },
			...Array.from({ length: 6 }, (_, index) => ({
				key: `c${index}`,
				kind: 'context' as const,
				hunkIndex: 0,
				hunkId: 'h0',
				beforeLine: index + 1,
				afterLine: index + 1,
				text: `line ${index + 1}`,
				diffLineIndex: index,
			})),
		];

		expect(buildGitReviewCommentContext(rows, 'after', 4)).toEqual([
			'@@ -1,5 +1,5 @@',
			' line 2',
			' line 3',
			' line 4',
			' line 5',
			' line 6',
		]);
	});

	it('extends the Markdown fence when source context contains backticks', () => {
		const message = buildGitReviewCommentMessage({
			source: {
				kind: 'commit',
				shortHash: '1234567',
				subject: 'Document code',
				baseLabel: 'parent 7654321',
			},
			filePath: 'README.md',
			side: 'after',
			line: 3,
			contextLines: ['+```ts'],
			body: 'Keep the context block intact.',
			severity: 'note',
		});

		expect(message).toContain('````diff\n+```ts\n````');
	});

	it('uses a longer inline-code fence for paths containing backticks', () => {
		const message = buildGitReviewCommentMessage({
			source: {
				kind: 'commit',
				shortHash: '1234567',
				subject: 'Keep unusual paths',
				baseLabel: 'parent 7654321',
			},
			filePath: 'src/odd`name.ts',
			side: 'after',
			line: 3,
			contextLines: [],
			body: 'Keep this path legible.',
			severity: 'note',
		});

		expect(message).toContain('Location: ``src/odd`name.ts``:3 (new line)');
	});
});
