// Inline snippet trigger detection for the chat composer. Typing the configured
// trigger prefix (default ";;") at a word boundary opens the snippet palette,
// which replaces the trigger span with the expanded snippet at the caret.

export const DEFAULT_SNIPPET_TRIGGER = ';;';
export const SNIPPET_TRIGGER_MIN_LENGTH = 2;
export const SNIPPET_TRIGGER_MAX_LENGTH = 4;

const FORBIDDEN_SNIPPET_TRIGGER_CHARS = /[\s/@]/;
const SHORT_NAME_ONLY_SNIPPET_TRIGGER = /^[a-z0-9_-]+$/i;

export type SnippetTriggerValidationError = 'format' | 'charset' | null;

function hasControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || codePoint === 0x7f;
	});
}

// Reports which rule a candidate trigger violates, if any. Format covers the
// length bounds plus reserved characters (whitespace, slash, at-sign, control
// chars); charset rejects prefixes made only of short-name characters, which
// would be indistinguishable from the prose and names that follow them.
export function snippetTriggerValidationError(value: string): SnippetTriggerValidationError {
	if (
		value.length < SNIPPET_TRIGGER_MIN_LENGTH ||
		value.length > SNIPPET_TRIGGER_MAX_LENGTH ||
		FORBIDDEN_SNIPPET_TRIGGER_CHARS.test(value) ||
		hasControlCharacter(value)
	) {
		return 'format';
	}
	if (SHORT_NAME_ONLY_SNIPPET_TRIGGER.test(value)) return 'charset';
	return null;
}

export function isValidSnippetTrigger(value: string): boolean {
	return snippetTriggerValidationError(value) === null;
}

// Coerces persisted or user-entered values to a valid trigger prefix.
export function normalizeSnippetTrigger(value: unknown): string {
	return typeof value === 'string' && isValidSnippetTrigger(value)
		? value
		: DEFAULT_SNIPPET_TRIGGER;
}

export interface SnippetTrigger {
	start: number;
	end: number;
	query: string;
}

export interface SnippetTriggerReplacement {
	text: string;
	caret: number;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The trigger is the configured prefix at a word boundary followed by an
// optionally-empty run of short-name characters up to the caret.
export function findSnippetTrigger(
	value: string,
	caret: number,
	triggerPrefix: unknown,
): SnippetTrigger | null {
	if (typeof triggerPrefix !== 'string' || !isValidSnippetTrigger(triggerPrefix)) return null;
	const boundedCaret = Math.max(0, Math.min(caret, value.length));
	if (/[a-z0-9_-]/i.test(value[boundedCaret] ?? '')) return null;
	const prefix = value.slice(0, boundedCaret);
	const pattern = new RegExp(`(^|\\s)${escapeRegExp(triggerPrefix)}([a-z0-9_-]*)$`);
	const match = prefix.match(pattern);
	if (!match || match.index === undefined) return null;
	const leadingWhitespace = match[1] ?? '';
	return {
		start: match.index + leadingWhitespace.length,
		end: boundedCaret,
		query: match[2] ?? '',
	};
}

// Replaces the trigger span with the expanded snippet text. No trailing
// separator is added: templates are often code, unlike file mentions which
// append a space.
export function applySnippetTriggerReplacement(
	value: string,
	trigger: { start: number; end: number },
	expandedText: string,
): SnippetTriggerReplacement {
	const text = value.slice(0, trigger.start) + expandedText + value.slice(trigger.end);
	return { text, caret: trigger.start + expandedText.length };
}
