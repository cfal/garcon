// Bounds document construction and serialization as well as clipboard detection.
export const MAX_COMPOSER_MARKDOWN_LENGTH = 32_768;
export const MAX_COMPOSER_MARKDOWN_NODES = 2_000;

export function isComposerMarkdownSized(source: string): boolean {
	return source.length > 0 && source.length <= MAX_COMPOSER_MARKDOWN_LENGTH;
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
