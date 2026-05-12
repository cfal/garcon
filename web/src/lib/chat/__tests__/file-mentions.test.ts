import { describe, expect, it } from 'vitest';
import { applyFileMention, findFileMentionTrigger, formatFileMentionPath } from '../file-mentions';

describe('file mention helpers', () => {
	it('detects @ triggers at the caret', () => {
		expect(findFileMentionTrigger('read @src/ind', 'read @src/ind'.length)).toEqual({
			start: 5,
			end: 13,
			query: 'src/ind',
		});
	});

	it('ignores @ inside words and email addresses', () => {
		expect(findFileMentionTrigger('alex@example.com', 'alex@example.com'.length)).toBeNull();
		expect(findFileMentionTrigger('branch@{upstream}', 'branch@{upstream}'.length)).toBeNull();
	});

	it('replaces a trigger in the middle of text', () => {
		const text = 'please inspect @sr before continuing';
		const trigger = findFileMentionTrigger(text, 'please inspect @sr'.length);
		expect(trigger).not.toBeNull();

		const replacement = applyFileMention(text, trigger!, 'src/main.ts');

		expect(replacement.text).toBe('please inspect @src/main.ts before continuing');
		expect(replacement.caret).toBe('please inspect @src/main.ts '.length);
	});

	it('does not add a leading space for a mention at the beginning', () => {
		const text = '@sr';
		const trigger = findFileMentionTrigger(text, text.length);

		const replacement = applyFileMention(text, trigger!, 'src/main.ts');

		expect(replacement.text).toBe('@src/main.ts ');
		expect(replacement.caret).toBe('@src/main.ts '.length);
	});

	it('quotes paths with whitespace', () => {
		expect(formatFileMentionPath('docs/design note.md')).toBe('"docs/design note.md"');
	});
});
