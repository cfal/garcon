import { describe, expect, it } from 'vitest';
import {
	cursorLineDown,
	cursorLineEnd,
	cursorLineStart,
	cursorLineUp,
	deleteToLineEnd,
	selectLineDown,
	selectLineEnd,
	selectLineStart,
	selectLineUp,
} from '@codemirror/commands';
import { COMPOSER_EDITOR_KEYMAP, ownsComposerEditorShortcut } from '../composer-editor-keymap.js';

function shortcut(
	key: string,
	modifiers: Partial<{
		ctrlKey: boolean;
		metaKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
		isComposing: boolean;
	}> = {},
) {
	return {
		key,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		isComposing: false,
		...modifiers,
	};
}

describe('composer editor keymap', () => {
	it('maps only the curated Emacs movement, selection, and deletion commands', () => {
		expect(COMPOSER_EDITOR_KEYMAP).toEqual([
			expect.objectContaining({ key: 'Ctrl-a', run: cursorLineStart, shift: selectLineStart }),
			expect.objectContaining({ key: 'Ctrl-e', run: cursorLineEnd, shift: selectLineEnd }),
			expect.objectContaining({ key: 'Ctrl-p', run: cursorLineUp, shift: selectLineUp }),
			expect.objectContaining({ key: 'Ctrl-n', run: cursorLineDown, shift: selectLineDown }),
			expect.objectContaining({ key: 'Ctrl-k', run: deleteToLineEnd }),
		]);
		expect(COMPOSER_EDITOR_KEYMAP).toHaveLength(5);
		expect(COMPOSER_EDITOR_KEYMAP.at(-1)?.shift).toBeUndefined();
	});

	it('owns exact Control movement chords and their Shift selection variants', () => {
		for (const key of ['a', 'e', 'p', 'n']) {
			expect(ownsComposerEditorShortcut(shortcut(key, { ctrlKey: true }))).toBe(true);
			expect(ownsComposerEditorShortcut(shortcut(key, { ctrlKey: true, shiftKey: true }))).toBe(
				true,
			);
		}
		expect(ownsComposerEditorShortcut(shortcut('k', { ctrlKey: true }))).toBe(true);
	});

	it('leaves scrolling and unrelated modifier chords to their existing owners', () => {
		for (const event of [
			shortcut('u', { ctrlKey: true }),
			shortcut('d', { ctrlKey: true }),
			shortcut('k', { ctrlKey: true, shiftKey: true }),
			shortcut('a', { metaKey: true }),
			shortcut('a', { ctrlKey: true, metaKey: true }),
			shortcut('a', { ctrlKey: true, altKey: true }),
			shortcut('Enter', { ctrlKey: true }),
		]) {
			expect(ownsComposerEditorShortcut(event)).toBe(false);
		}
	});

	it('owns every editor key while an input method is composing', () => {
		expect(ownsComposerEditorShortcut(shortcut('Escape', { isComposing: true }))).toBe(true);
		expect(ownsComposerEditorShortcut(shortcut('x'), true)).toBe(true);
	});
});
