import { describe, expect, it } from 'vitest';
import {
	buildChatToolDiff,
	MAX_CHAT_TOOL_DIFF_CHARS,
	MAX_CHAT_TOOL_DIFF_LINES,
	MAX_CHAT_TOOL_DIFF_MATRIX_CELLS,
} from '../content/chat-tool-diff';

describe('buildChatToolDiff', () => {
	it('returns changed lines for inputs within the work budget', () => {
		expect(buildChatToolDiff('first\nold', 'first\nnew')).toEqual({
			kind: 'ready',
			lines: [
				{ type: 'removed', content: 'old', lineNum: 2 },
				{ type: 'added', content: 'new', lineNum: 2 },
			],
		});
	});

	it.each([1, 226, 450])(
		'keeps original line numbers for a localized edit on line %i',
		(lineNum) => {
			const lines = Array.from({ length: 450 }, (_, i) => `const value = ${i};`);
			const replacement = 'const value = null;';
			expect(
				buildChatToolDiff(lines.join('\n'), lines.with(lineNum - 1, replacement).join('\n')),
			).toEqual({
				kind: 'ready',
				lines: [
					{ type: 'removed', content: lines[lineNum - 1], lineNum },
					{ type: 'added', content: replacement, lineNum },
				],
			});
		},
	);

	it('matches duplicate lines backwards across the shared prefix and suffix', () => {
		expect(buildChatToolDiff('head\na\na\ntail', 'head\na\nb\ntail')).toEqual({
			kind: 'ready',
			lines: [
				{ type: 'removed', content: 'a', lineNum: 2 },
				{ type: 'added', content: 'b', lineNum: 3 },
			],
		});
		expect(buildChatToolDiff('a\nb\na', 'a\nb\nb\na')).toEqual({
			kind: 'ready',
			lines: [{ type: 'added', content: 'b', lineNum: 2 }],
		});
	});

	it('retains change order and interior matches when neither end matches', () => {
		expect(buildChatToolDiff('first\nkeep\nlast', 'new first\nkeep\nnew last')).toEqual({
			kind: 'ready',
			lines: [
				{ type: 'removed', content: 'first', lineNum: 1 },
				{ type: 'added', content: 'new first', lineNum: 1 },
				{ type: 'removed', content: 'last', lineNum: 3 },
				{ type: 'added', content: 'new last', lineNum: 3 },
			],
		});
	});

	it('handles identical files and a changed trailing empty line', () => {
		expect(buildChatToolDiff('', '')).toEqual({ kind: 'ready', lines: [] });
		expect(buildChatToolDiff('a\n\na', 'a\n\na')).toEqual({ kind: 'ready', lines: [] });
		expect(buildChatToolDiff('a\n', 'a')).toEqual({
			kind: 'ready',
			lines: [{ type: 'removed', content: '', lineNum: 2 }],
		});
	});

	it('rejects a diff whose LCS matrix would exceed the work budget', () => {
		const sideLength = Math.floor(Math.sqrt(MAX_CHAT_TOOL_DIFF_MATRIX_CELLS)) + 1;
		const oldContent = Array.from({ length: sideLength }, (_, index) => `old-${index}`).join('\n');
		const newContent = Array.from({ length: sideLength }, (_, index) => `new-${index}`).join('\n');

		expect(buildChatToolDiff(oldContent, newContent)).toEqual({ kind: 'too-large' });
	});

	it('checks the full inputs against the existing budgets before removing identical edges', () => {
		const atLimit = Array.from(
			{ length: Math.sqrt(MAX_CHAT_TOOL_DIFF_MATRIX_CELLS) - 1 },
			() => 'a',
		);
		expect(buildChatToolDiff(atLimit.join('\n'), atLimit.join('\n'))).toEqual({
			kind: 'ready',
			lines: [],
		});
		expect(
			buildChatToolDiff([...atLimit, 'old'].join('\n'), [...atLimit, 'new'].join('\n')),
		).toEqual({ kind: 'too-large' });
		expect(buildChatToolDiff('a'.repeat(MAX_CHAT_TOOL_DIFF_CHARS), 'a')).toEqual({
			kind: 'too-large',
		});
		expect(buildChatToolDiff('\n'.repeat(MAX_CHAT_TOOL_DIFF_LINES), '')).toEqual({
			kind: 'too-large',
		});
	});
});
