import type { Node } from '@tiptap/pm/model';

// Bounds document construction and serialization as well as clipboard detection.
export const MAX_COMPOSER_MARKDOWN_LENGTH = 32_768;
export const MAX_COMPOSER_MARKDOWN_NODES = 2_000;

export function isComposerMarkdownSized(source: string): boolean {
	return source.length <= MAX_COMPOSER_MARKDOWN_LENGTH;
}

export function exceedsComposerMarkdownNodeLimit(doc: Node): boolean {
	// Every descendant occupies at least one position; the document itself occupies none.
	if (doc.content.size < MAX_COMPOSER_MARKDOWN_NODES) return false;
	let count = 1;
	doc.descendants(() => ++count <= MAX_COMPOSER_MARKDOWN_NODES);
	return count > MAX_COMPOSER_MARKDOWN_NODES;
}
