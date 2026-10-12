import { describe, expect, it } from 'vitest';
import { CollapsedPasteState } from '../collapsed-paste-state.svelte';

function createState(initialText = '') {
	const draft = $state({ text: initialText });
	const pastes = new CollapsedPasteState({
		get text() {
			return draft.text;
		},
		setText: (text) => {
			draft.text = text;
		},
	});
	return { draft, pastes };
}

const TABLE = `| a | b |\n${'| 1 | 2 |\n'.repeat(119)}`;
const TABLE_LABEL = '[Pasted Content 1200 chars]';

describe('CollapsedPasteState', () => {
	it('shows a label for a paste while the draft keeps the full text', () => {
		const { draft, pastes } = createState('review: now');
		const caret = pastes.paste(TABLE, { start: 8, end: 8 });

		expect(draft.text).toBe(`review: ${TABLE}now`);
		expect(pastes.displayText).toBe(`review: ${TABLE_LABEL}now`);
		expect(caret).toBe(8 + TABLE_LABEL.length);
	});

	it('replaces the selection, including a label it cuts through', () => {
		const { draft, pastes } = createState('ab');
		pastes.paste(TABLE, { start: 1, end: 1 });
		const other = 'z'.repeat(1001);

		const caret = pastes.paste(other, { start: 0, end: 5 });

		expect(draft.text).toBe(`${other}b`);
		expect(pastes.displayText).toBe('[Pasted Content 1001 chars]b');
		expect(caret).toBe('[Pasted Content 1001 chars]'.length);
	});

	it('numbers a second paste of the same size', () => {
		const { draft, pastes } = createState();
		pastes.paste(TABLE, { start: 0, end: 0 });
		pastes.paste(TABLE, { start: TABLE_LABEL.length, end: TABLE_LABEL.length });

		expect(pastes.displayText).toBe(`${TABLE_LABEL}${TABLE_LABEL} #2`);
		expect(draft.text).toBe(`${TABLE}${TABLE}`);
	});

	it('removes the whole paste when its label is edited', () => {
		const { draft, pastes } = createState('ab');
		pastes.paste(TABLE, { start: 1, end: 1 });
		const display = pastes.displayText;

		const caret = pastes.applyDisplayEdit(display.slice(0, -2) + display.slice(-1), display.length - 2);

		expect(draft.text).toBe('ab');
		expect(pastes.displayText).toBe('ab');
		expect(caret).toBe(1);
	});

	it('follows the draft across a clear and a restore of the same text', () => {
		const { draft, pastes } = createState();
		pastes.paste(TABLE, { start: 0, end: 0 });
		const submitted = draft.text;

		draft.text = '';
		expect(pastes.displayText).toBe('');
		draft.text = 'other chat draft';
		expect(pastes.displayText).toBe('other chat draft');
		draft.text = submitted;
		expect(pastes.displayText).toBe(TABLE_LABEL);
	});

	it('shows the full text once expanded and keeps it expanded', () => {
		const { draft, pastes } = createState('ab');
		pastes.paste(TABLE, { start: 1, end: 1 });

		expect(pastes.expandedOffset(1 + TABLE_LABEL.length)).toBe(1 + TABLE.length);
		pastes.expandAll();

		expect(pastes.displayText).toBe(`a${TABLE}b`);
		expect(draft.text).toBe(`a${TABLE}b`);
	});

	it('forgets the oldest pastes that no draft is showing', () => {
		const { draft, pastes } = createState();
		const contents = Array.from({ length: 10 }, (_, index) => String(index).repeat(1001 + index));
		for (const content of contents) {
			draft.text = '';
			pastes.paste(content, { start: 0, end: 0 });
		}

		draft.text = contents[9];
		expect(pastes.displayText).toBe('[Pasted Content 1010 chars]');
		draft.text = contents[2];
		expect(pastes.displayText).toBe('[Pasted Content 1003 chars]');
		draft.text = contents[1];
		expect(pastes.displayText).toBe(contents[1]);
	});
});
