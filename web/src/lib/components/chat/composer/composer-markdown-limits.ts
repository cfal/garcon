// Bounds document construction and serialization as well as clipboard detection.
export const MAX_COMPOSER_MARKDOWN_LENGTH = 32_768;
export const MAX_COMPOSER_MARKDOWN_NODES = 2_000;

export function isComposerMarkdownSized(source: string): boolean {
	return source.length <= MAX_COMPOSER_MARKDOWN_LENGTH;
}

