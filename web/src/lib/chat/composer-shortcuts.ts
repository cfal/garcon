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
