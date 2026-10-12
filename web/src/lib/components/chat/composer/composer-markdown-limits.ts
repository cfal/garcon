// Bounds document construction and serialization as well as clipboard detection.
export const MAX_COMPOSER_MARKDOWN_LENGTH = 32_768;
export const MAX_COMPOSER_MARKDOWN_NODES = 2_000;

export function isComposerMarkdownSized(source: string): boolean {
	return source.length > 0 && source.length <= MAX_COMPOSER_MARKDOWN_LENGTH;
}

// Cheap main-thread screen for block markers and inline delimiters; the Worker's lexer decides
// whether the text really is formatted. Every quantifier is bounded or anchored.
const MARKDOWN_SYNTAX =
	/^[ \t]{0,3}(?:#{1,6}[ \t]|>|[-*+][ \t]|\d{1,9}[.)][ \t]|`{3}|~{3})|[*_`~]\S|\]\(/m;

export function isMarkdownCandidate(source: string): boolean {
	return (
		isComposerMarkdownSized(source) &&
		(MARKDOWN_SYNTAX.test(source) || isMarkdownTableCandidate(source))
	);
}

export function isMarkdownTableCandidate(source: string): boolean {
	return (
		isComposerMarkdownSized(source) &&
		/\|/.test(source) &&
		// Each optional part starts with a distinct character, so a long run of leading
		// whitespace is scanned once instead of being split between them.
		/^[ \t>]*(?:(?:[-*+]|\d+[.)]) [ \t]*)?(?:\|[ \t]*)?:?-+:?[ \t]*\|/m.test(source)
	);
}
