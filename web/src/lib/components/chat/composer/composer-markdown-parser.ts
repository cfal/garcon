import type { JSONContent } from '@tiptap/core';
import { composerMarkdownCodec } from './composer-markdown-codec.js';
import {
	joinComposerMarkdownBlocks,
	type ComposerMarkdownBlock,
} from './composer-markdown-blocks.js';
import {
	isComposerMarkdownSized,
	MAX_COMPOSER_MARKDOWN_NODES,
} from './composer-markdown-limits.js';

// The Markdown parser lifts a lone image out of its paragraph, but draft images are inline.
const IMAGE_BLOCK_PARENTS = new Set(['doc', 'blockquote', 'listItem', 'taskItem']);

export interface ComposerMarkdownRequest {
	source: string;
	caret?: number;
}

export interface ComposerMarkdownDocument {
	document: JSONContent;
	selection?: number;
	selectionMarks?: JSONContent['marks'];
	/**
	 * Exact source of each top-level node with the whitespace that follows it; null where a node
	 * cannot be traced to its own source.
	 */
	sources: (string | null)[];
}

export interface ComposerMarkdownPasteRequest {
	blocks: ComposerMarkdownBlock<JSONContent>[];
	originalCount: number;
	marker: string;
	text: string;
}

export function serializeComposerMarkdownPaste({
	blocks,
	originalCount,
	marker,
	text,
}: ComposerMarkdownPasteRequest): string {
	const replaceMarker = (node: JSONContent): JSONContent => ({
		...node,
		...(node.text ? { text: node.text.replace(marker, () => text) } : {}),
		...(node.content ? { content: node.content.map(replaceMarker) } : {}),
	});
	return joinComposerMarkdownBlocks(blocks, originalCount, (nodes) =>
		composerMarkdownCodec.serialize({ type: 'doc', content: nodes.map(replaceMarker) }),
	);
}

function wrapBlockImages(node: JSONContent): JSONContent {
	if (!node.content) return node;
	const wrap = IMAGE_BLOCK_PARENTS.has(node.type ?? '');
	return {
		...node,
		content: node.content.map((child) =>
			wrap && child.type === 'image'
				? { type: 'paragraph', content: [child] }
				: wrapBlockImages(child),
		),
	};
}

// Parses each top-level token on its own so every node maps to the source that produced it.
// `ended` reports that the source stops where its last node does, with nothing left after it.
function parseBlocks(source: string): (ComposerMarkdownDocument & { ended: boolean }) | null {
	const tokens = composerMarkdownCodec.lex(source);
	// Reference definitions have no editable node and would disappear when their block changes.
	if (Object.keys(tokens.links).length > 0) return null;
	const content: JSONContent[] = [];
	const sources: (string | null)[] = [];
	let leading = '';
	let lexed = '';
	let ended = false;
	for (const token of tokens) {
		lexed += token.raw;
		const nodes =
			token.type === 'space'
				? []
				: (wrapBlockImages(composerMarkdownCodec.parse(token.raw)).content ?? []).filter(
						// Blank lines stay in the source instead of becoming empty paragraphs.
						(node) => node.type !== 'paragraph' || Boolean(node.content?.length),
					);
		if (nodes.length === 0) {
			const last = sources.length - 1;
			if (last < 0) leading += token.raw;
			else if (sources[last] !== null) sources[last] += token.raw;
			ended = false;
			continue;
		}
		ended = !/\s$/.test(token.raw);
		for (const node of nodes) {
			content.push(node);
			sources.push(nodes.length === 1 ? leading + token.raw : null);
		}
		leading = '';
	}
	// Tokens that do not add up to the draft cannot be used to write it back.
	const traceable = lexed === source.replace(/\r\n?/g, '\n');
	if (content.length === 0) {
		content.push({ type: 'paragraph' });
		sources.push(source);
	}
	return {
		document: { type: 'doc', content },
		sources: traceable ? sources : sources.map(() => null),
		ended,
	};
}

// Locates the end of the last line of text in the document.
function trailingSelection(document: JSONContent): number | undefined {
	let position = (document.content ?? []).reduce((size, child) => size + jsonNodeSize(child), 0);
	let node = document.content?.at(-1);
	while (node) {
		const last = node.content?.at(-1);
		if (!last) return undefined;
		position -= 1;
		if (last.text !== undefined) return position;
		node = last;
	}
	return undefined;
}

interface CaretPlacement {
	selection: number;
	marks: JSONContent['marks'];
}

// Maps a source caret through Markdown delimiters by inserting marker text there and reading
// back where it lands. Returns null when the marker changes the document's structure.
function placeCaret(
	source: string,
	caret: number,
	document: JSONContent,
	marker: string,
): CaretPlacement | null {
	const marked = parseBlocks(source.slice(0, caret) + marker + source.slice(caret))?.document;
	if (!marked) return null;
	let placement: CaretPlacement | null = null;
	const strip = (node: JSONContent, position: number): JSONContent => {
		if (node.text !== undefined) {
			const offset = node.text.indexOf(marker);
			if (offset < 0) return node;
			placement = {
				selection: position + offset,
				marks: node.marks ?? [],
			};
			return { ...node, text: node.text.replace(marker, '') };
		}
		if (!node.content) return node;
		let next = position + (node.type === 'doc' ? 0 : 1);
		const content = node.content
			.map((child) => {
				const result = strip(child, next);
				next += jsonNodeSize(result);
				return result;
			})
			.filter((child) => child.text !== '');
		return { ...node, content };
	};
	const same = JSON.stringify(strip(marked, 0)) === JSON.stringify(document);
	return same ? placement : null;
}

export function parseComposerMarkdown({
	source,
	caret,
}: ComposerMarkdownRequest): ComposerMarkdownDocument | null {
	if (!isComposerMarkdownSized(source)) return null;
	const blocks = parseBlocks(source);
	if (!blocks) return null;
	const { ended, ...parsed } = blocks;
	const pending = [parsed.document];
	let count = 0;
	while (pending.length) {
		if (++count > MAX_COMPOSER_MARKDOWN_NODES) return null;
		pending.push(...(pending.pop()?.content ?? []));
	}
	if (caret !== undefined) {
		parsed.selectionMarks = [];
		let marker = 'garconComposerCaret';
		while (source.includes(marker)) marker += 'X';
		// Word characters after a closing `_` keep it from closing, so punctuation leads a second try.
		const placement =
			placeCaret(source, caret, parsed.document, marker) ??
			placeCaret(source, caret, parsed.document, '\u2e31' + marker);
		if (placement) {
			parsed.selection = placement.selection;
			parsed.selectionMarks = placement.marks;
		} else {
			// No marker survives after a table row's closing pipe, so a table that ends the
			// draft takes the caret in its last cell.
			const complete =
				caret === source.length &&
				ended &&
				parsed.document.content?.at(-1)?.type === 'table' &&
				parsed.sources.at(-1) !== null;
			const trailing = complete ? trailingSelection(parsed.document) : undefined;
			parsed.selection = trailing;
		}
	}
	return parsed;
}

function jsonNodeSize(node: JSONContent): number {
	if (node.text !== undefined) return node.text.length;
	return node.content ? 2 + node.content.reduce((sum, child) => sum + jsonNodeSize(child), 0) : 1;
}
