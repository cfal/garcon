interface EnterSubmissionParams {
	sendByShiftEnter: boolean;
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	isComposing: boolean;
	isMobile?: boolean;
}

interface ComposerEnterActionParams extends EnterSubmissionParams {
	steerWithCtrlEnter: boolean;
	altKey: boolean;
}

export type ComposerEnterAction = 'submit' | 'steer-preferred' | 'newline';

/**
 * Returns true when an Enter keypress should submit the composer.
 * On mobile, Enter always inserts a newline (submit via send button).
 * Ctrl/Cmd+Enter stays unbound regardless of preference.
 */
export function shouldSubmitOnEnter(params: EnterSubmissionParams): boolean {
	if (params.isMobile) return false;
	if (params.isComposing) return false;
	if (params.ctrlKey || params.metaKey) return false;
	return params.sendByShiftEnter ? params.shiftKey : !params.shiftKey;
}

/** Resolves compact-composer Enter behavior without claiming modified newline chords. */
export function resolveComposerEnterAction(params: ComposerEnterActionParams): ComposerEnterAction {
	if (params.isMobile || params.isComposing) return 'newline';
	if (
		params.steerWithCtrlEnter &&
		params.ctrlKey &&
		!params.metaKey &&
		!params.altKey &&
		!params.shiftKey
	)
		return 'steer-preferred';
	return shouldSubmitOnEnter(params) ? 'submit' : 'newline';
}

/** Shared predicate for whether the composer can submit. Used by both
 *  the button disabled state and the keyboard/form submit paths so
 *  they remain identical. */
export function canSubmitComposer(
	isDisabled: boolean,
	inputText: string,
	imageCount: number,
): boolean {
	void imageCount;
	if (isDisabled) return false;
	return inputText.trim().length > 0;
}
