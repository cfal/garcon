import { describe, expect, it, vi } from 'vitest';
import {
	clampComposerEditorSelection,
	composerEditorSelectionFromTextarea,
	restoreComposerEditorSelection,
} from '../composer-editor-selection.js';

describe('composer editor selection', () => {
	it('converts native forward and backward selections to anchor and head', () => {
		expect(
			composerEditorSelectionFromTextarea({
				selectionStart: 2,
				selectionEnd: 7,
				selectionDirection: 'forward',
			}),
		).toEqual({ anchor: 2, head: 7 });
		expect(
			composerEditorSelectionFromTextarea({
				selectionStart: 2,
				selectionEnd: 7,
				selectionDirection: 'backward',
			}),
		).toEqual({ anchor: 7, head: 2 });
	});

	it('clamps both ends independently', () => {
		expect(clampComposerEditorSelection({ anchor: 12, head: -3 }, 8)).toEqual({
			anchor: 8,
			head: 0,
		});
	});

	it('restores backward direction after clamping to current text', () => {
		const setSelectionRange = vi.fn();
		restoreComposerEditorSelection({ value: 'hello', setSelectionRange }, { anchor: 9, head: 2 });
		expect(setSelectionRange).toHaveBeenCalledWith(2, 5, 'backward');
	});
});
