export interface ComposerEditorSelection {
	anchor: number;
	head: number;
}

type ComposerSelectionReader = Pick<
	HTMLTextAreaElement,
	'selectionStart' | 'selectionEnd' | 'selectionDirection'
>;

type ComposerSelectionWriter = Pick<HTMLTextAreaElement, 'value' | 'setSelectionRange'>;

export function composerEditorSelectionFromTextarea(
	textarea: ComposerSelectionReader,
): ComposerEditorSelection {
	const start = textarea.selectionStart;
	const end = textarea.selectionEnd;
	return textarea.selectionDirection === 'backward'
		? { anchor: end, head: start }
		: { anchor: start, head: end };
}

export function clampComposerEditorSelection(
	selection: ComposerEditorSelection,
	documentLength: number,
): ComposerEditorSelection {
	return {
		anchor: Math.max(0, Math.min(selection.anchor, documentLength)),
		head: Math.max(0, Math.min(selection.head, documentLength)),
	};
}

export function restoreComposerEditorSelection(
	textarea: ComposerSelectionWriter,
	selection: ComposerEditorSelection,
): void {
	const clamped = clampComposerEditorSelection(selection, textarea.value.length);
	textarea.setSelectionRange(
		Math.min(clamped.anchor, clamped.head),
		Math.max(clamped.anchor, clamped.head),
		clamped.anchor > clamped.head ? 'backward' : 'forward',
	);
}
