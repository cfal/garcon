import { describe, expect, it } from 'vitest';
import {
	LARGE_PASTE_CHAR_THRESHOLD,
	applyDisplayEdit,
	collapseDraftText,
	expandedOffset,
	isLargePaste,
	nextCollapsedPasteLabel,
	normalizePastedText,
	type CollapsedPaste,
} from '../collapsed-pastes';

function paste(label: string, content: string): CollapsedPaste {
	return { label, content };
}

const TABLE = paste('[Pasted Content 1200 chars]', `| a | b |\n${'| 1 | 2 |\n'.repeat(119)}`);
const NOTES = paste('[Pasted Content 1500 chars]', 'n'.repeat(1500));

describe('isLargePaste', () => {
	it('collapses only pastes above the Codex threshold', () => {
		expect(isLargePaste('x'.repeat(LARGE_PASTE_CHAR_THRESHOLD))).toBe(false);
		expect(isLargePaste('x'.repeat(LARGE_PASTE_CHAR_THRESHOLD + 1))).toBe(true);
	});

	it('counts characters rather than UTF-16 units', () => {
		expect(isLargePaste('\u{1F600}'.repeat(LARGE_PASTE_CHAR_THRESHOLD))).toBe(false);
		expect(isLargePaste('\u{1F600}'.repeat(LARGE_PASTE_CHAR_THRESHOLD + 1))).toBe(true);
	});
});

describe('normalizePastedText', () => {
	it('converts carriage returns to newlines', () => {
		expect(normalizePastedText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
	});
});

describe('nextCollapsedPasteLabel', () => {
	it('labels by character count', () => {
		expect(nextCollapsedPasteLabel('\u{1F600}'.repeat(1001), [])).toBe(
			'[Pasted Content 1001 chars]',
		);
	});

	it('suffixes equally sized pastes from the highest remembered suffix', () => {
		const content = 'x'.repeat(1200);
		const first = paste(nextCollapsedPasteLabel(content, []), content);
		const second = paste(nextCollapsedPasteLabel(content, [first]), content);
		expect(second.label).toBe('[Pasted Content 1200 chars] #2');
		expect(nextCollapsedPasteLabel(content, [first, second])).toBe(
			'[Pasted Content 1200 chars] #3',
		);
		expect(nextCollapsedPasteLabel(content, [second])).toBe('[Pasted Content 1200 chars] #3');
		expect(nextCollapsedPasteLabel(content, [NOTES])).toBe('[Pasted Content 1200 chars]');
	});
});

describe('collapseDraftText', () => {
	it('replaces remembered pastes with their labels in text order', () => {
		const text = `see ${NOTES.content} and ${TABLE.content}!`;
		const draft = collapseDraftText(text, [TABLE, NOTES]);
		expect(draft.displayText).toBe(`see ${NOTES.label} and ${TABLE.label}!`);
		expect(draft.chips.map((chip) => [chip.label, chip.start])).toEqual([
			[NOTES.label, 4],
			[TABLE.label, 4 + NOTES.label.length + 5],
		]);
	});

	it('leaves pastes that are no longer in the text expanded', () => {
		const draft = collapseDraftText('typed instead', [TABLE]);
		expect(draft).toEqual({ displayText: 'typed instead', chips: [] });
	});

	it('gives each identical paste its own occurrence', () => {
		const second = paste(`${TABLE.label} #2`, TABLE.content);
		const draft = collapseDraftText(`${TABLE.content}-${TABLE.content}`, [TABLE, second]);
		expect(draft.displayText).toBe(`${TABLE.label}-${second.label}`);
	});

	it('does not split a paste that contains a shorter one', () => {
		const inner = paste('[Pasted Content 1100 chars]', NOTES.content.slice(0, 1100));
		const draft = collapseDraftText(NOTES.content, [inner, NOTES]);
		expect(draft.displayText).toBe(NOTES.label);
	});
});

describe('expandedOffset', () => {
	const draft = collapseDraftText(`ab${TABLE.content}cd`, [TABLE]);

	it('maps offsets around a label to the full text', () => {
		expect(expandedOffset(draft, 1)).toBe(1);
		expect(expandedOffset(draft, 2)).toBe(2);
		expect(expandedOffset(draft, 2 + TABLE.label.length)).toBe(2 + TABLE.content.length);
		expect(expandedOffset(draft, 3 + TABLE.label.length)).toBe(3 + TABLE.content.length);
	});

	it('maps an offset inside a label to the end of its paste', () => {
		expect(expandedOffset(draft, 5)).toBe(2 + TABLE.content.length);
	});
});

describe('applyDisplayEdit', () => {
	const remembered = [TABLE, NOTES];
	const draft = collapseDraftText(`ab${TABLE.content}cd${NOTES.content}`, remembered);
	const tableEnd = 2 + TABLE.label.length;

	it('keeps pastes collapsed while text around them changes', () => {
		const next = `abX${TABLE.label}cd${NOTES.label}!`;
		expect(applyDisplayEdit(draft, next, remembered)).toEqual({
			text: `abX${TABLE.content}cd${NOTES.content}!`,
			caret: null,
		});
	});

	it('removes the whole paste when backspace deletes the end of its label', () => {
		const next = draft.displayText.slice(0, tableEnd - 1) + draft.displayText.slice(tableEnd);
		expect(applyDisplayEdit(draft, next, remembered, tableEnd - 1)).toEqual({
			text: `abcd${NOTES.content}`,
			caret: 2,
		});
	});

	it('removes the whole paste when typing inside its label and keeps the typed text', () => {
		const next = `${draft.displayText.slice(0, 5)}Z${draft.displayText.slice(5)}`;
		expect(applyDisplayEdit(draft, next, remembered, 6)).toEqual({
			text: `abZcd${NOTES.content}`,
			caret: 3,
		});
	});

	it('removes every paste a replaced selection cuts through', () => {
		const selectionStart = 5;
		const selectionEnd = tableEnd + 2 + 4;
		const next = `${draft.displayText.slice(0, selectionStart)}new${draft.displayText.slice(selectionEnd)}`;
		expect(applyDisplayEdit(draft, next, remembered, selectionStart + 3)).toEqual({
			text: 'abnew',
			caret: 5,
		});
	});

	it('drops a paste whose label is fully deleted without rewriting the edit', () => {
		const next = `ab${draft.displayText.slice(tableEnd)}`;
		expect(applyDisplayEdit(draft, next, remembered, 2)).toEqual({
			text: `abcd${NOTES.content}`,
			caret: null,
		});
	});

	it('reads a character typed against a label boundary as outside the label', () => {
		const before = collapseDraftText(TABLE.content, [TABLE]);
		expect(applyDisplayEdit(before, `[${TABLE.label}`, [TABLE], 1)).toEqual({
			text: `[${TABLE.content}`,
			caret: null,
		});
		expect(applyDisplayEdit(before, `${TABLE.label}]`, [TABLE], TABLE.label.length + 1)).toEqual({
			text: `${TABLE.content}]`,
			caret: null,
		});
	});

	it('resolves a remembered label that returns through a paste or undo', () => {
		const cut = collapseDraftText(`abcd${NOTES.content}`, remembered);
		const next = `abcd${NOTES.label}${TABLE.label}`;
		expect(applyDisplayEdit(cut, next, remembered, next.length).text).toBe(
			`abcd${NOTES.content}${TABLE.content}`,
		);
	});

	it('does not resolve a label that prefixes an equally sized later paste', () => {
		const second = paste(`${TABLE.label} #2`, `${TABLE.content.slice(0, -2)}!\n`);
		const empty = collapseDraftText('', [TABLE, second]);
		expect(applyDisplayEdit(empty, second.label, [TABLE, second]).text).toBe(second.content);
	});

	it('sends a typed label literally when no paste remembers it', () => {
		const empty = collapseDraftText('', []);
		expect(applyDisplayEdit(empty, TABLE.label, []).text).toBe(TABLE.label);
	});
});
