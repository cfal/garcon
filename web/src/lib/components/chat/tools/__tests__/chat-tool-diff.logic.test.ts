import { describe, expect, it } from 'vitest';
import { buildChatToolDiff, MAX_CHAT_TOOL_DIFF_MATRIX_CELLS } from '../content/chat-tool-diff';

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

	it('rejects a diff whose LCS matrix would exceed the work budget', () => {
		const sideLength = Math.floor(Math.sqrt(MAX_CHAT_TOOL_DIFF_MATRIX_CELLS)) + 1;
		const oldContent = Array.from({ length: sideLength }, (_, index) => `old-${index}`).join('\n');
		const newContent = Array.from({ length: sideLength }, (_, index) => `new-${index}`).join('\n');

		expect(buildChatToolDiff(oldContent, newContent)).toEqual({ kind: 'too-large' });
	});
});
