interface EnterSubmissionParams {
	sendByShiftEnter: boolean;
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	isComposing: boolean;
}

/**
 * Returns true when an Enter keypress should submit the composer.
 * Ctrl/Cmd+Enter stays unbound regardless of preference.
 */
export function shouldSubmitOnEnter(params: EnterSubmissionParams): boolean {
	if (params.isComposing) return false;
	if (params.ctrlKey || params.metaKey) return false;
	return params.sendByShiftEnter ? params.shiftKey : !params.shiftKey;
}

/** Shared predicate for whether the composer can submit. Used by both
 *  the button disabled state and the keyboard/form submit paths so
 *  they remain identical. */
export function canSubmitComposer(isDisabled: boolean, inputText: string, imageCount: number): boolean {
	void imageCount;
	if (isDisabled) return false;
	return inputText.trim().length > 0;
}
