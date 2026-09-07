export interface PromptEditorSelection {
	anchor: number;
	head: number;
}

type TextareaSelectionReader = Pick<
	HTMLTextAreaElement,
	'selectionStart' | 'selectionEnd' | 'selectionDirection'
>;

type TextareaSelectionWriter = Pick<HTMLTextAreaElement, 'value' | 'setSelectionRange'>;

export function promptEditorSelectionFromTextarea(
	textarea: TextareaSelectionReader,
): PromptEditorSelection {
	const start = textarea.selectionStart;
	const end = textarea.selectionEnd;
	return textarea.selectionDirection === 'backward'
		? { anchor: end, head: start }
		: { anchor: start, head: end };
}

export function clampPromptEditorSelection(
	selection: PromptEditorSelection,
	documentLength: number,
): PromptEditorSelection {
	return {
		anchor: Math.max(0, Math.min(selection.anchor, documentLength)),
		head: Math.max(0, Math.min(selection.head, documentLength)),
	};
}

export function restorePromptEditorSelection(
	textarea: TextareaSelectionWriter,
	selection: PromptEditorSelection,
): void {
	const clamped = clampPromptEditorSelection(selection, textarea.value.length);
	textarea.setSelectionRange(
		Math.min(clamped.anchor, clamped.head),
		Math.max(clamped.anchor, clamped.head),
		clamped.anchor > clamped.head ? 'backward' : 'forward',
	);
}
