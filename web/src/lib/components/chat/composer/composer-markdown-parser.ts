import { MarkdownManager } from '@tiptap/markdown';
import type { JSONContent } from '@tiptap/core';
import { composerMarkdownEditorExtensions } from './composer-markdown-extensions.js';
import { configureComposerMarkdown, serializeComposerMarkdown } from './composer-markdown.js';
import {
	joinComposerMarkdownBlocks,
	type ComposerMarkdownBlock,
} from './composer-markdown-blocks.js';
import {
	isComposerMarkdownSized,
	isMarkdownCandidate,
	MAX_COMPOSER_MARKDOWN_NODES,
} from './composer-markdown-limits.js';

const manager = new MarkdownManager({
	extensions: composerMarkdownEditorExtensions(),
	markedOptions: { breaks: true },
});
configureComposerMarkdown(manager);
const marked = manager.instance;

// Tokens that make pasted text worth showing formatted. Thematic breaks and indented code are
// left out because plain text produces them by accident.
const FORMATTING_TOKENS = new Set([
	'table',
	'list',
	'taskList',
	'heading',
	'blockquote',
	'strong',
	'em',
	'del',
	'codespan',
	'image',
]);

function isFormattingToken(token: { type: string; raw: string; codeBlockStyle?: string }): boolean {
	if (token.type === 'code') return token.codeBlockStyle !== 'indented';
	// A bare address is a link token too; only a written `[label](url)` counts.
	if (token.type === 'link') return token.raw.startsWith('[');
	return FORMATTING_TOKENS.has(token.type);
}

// The Markdown parser lifts a lone image out of its paragraph, but draft images are inline.
const IMAGE_BLOCK_PARENTS = new Set(['doc', 'blockquote', 'listItem', 'taskItem']);

export interface ComposerMarkdownRequest {
	source: string;
	pastedText?: string;
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
		serializeComposerMarkdown(manager, { type: 'doc', content: nodes.map(replaceMarker) }),
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
function parseBlocks(source: string): ComposerMarkdownDocument & { ended: boolean } {
	const content: JSONContent[] = [];
	const sources: (string | null)[] = [];
	let leading = '';
	let lexed = '';
	let ended = false;
	for (const token of marked.lexer(source)) {
		lexed += token.raw;
		const nodes =
			token.type === 'space'
				? []
				: (wrapBlockImages(manager.parse(token.raw)).content ?? []).filter(
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
	/** Ancestors of the text holding the caret, outermost first. */
	path: JSONContent[];
	/** Position of that text among its siblings. */
	index: number;
	/** The part of that text before the caret. */
	before: string;
}

// Maps a source caret through Markdown delimiters by inserting marker text there and reading
// back where it lands. Returns null when the marker changes the document's structure.
function placeCaret(
	source: string,
	caret: number,
	document: JSONContent,
	marker: string,
): CaretPlacement | null {
	const marked = parseBlocks(source.slice(0, caret) + marker + source.slice(caret)).document;
	let placement: CaretPlacement | null = null;
	const strip = (
		node: JSONContent,
		position: number,
		path: JSONContent[],
		index: number,
	): JSONContent => {
		if (node.text !== undefined) {
			const offset = node.text.indexOf(marker);
			if (offset < 0) return node;
			placement = {
				selection: position + offset,
				marks: node.marks ?? [],
				path,
				index,
				before: node.text.slice(0, offset),
			};
			return { ...node, text: node.text.replace(marker, '') };
		}
		if (!node.content) return node;
		let next = position + (node.type === 'doc' ? 0 : 1);
		const inner = [...path, node];
		const content = node.content
			.map((child, childIndex) => {
				const result = strip(child, next, inner, childIndex);
				next += jsonNodeSize(result);
				return result;
			})
			.filter((child) => child.text !== '');
		return { ...node, content };
	};
	const same = JSON.stringify(strip(marked, 0, [], 0)) === JSON.stringify(document);
	return same ? placement : null;
}

// Reports syntax that parses as complete but is usually a longer construct still being typed.
// It stays in source, where the rest of it can be written.
function isUnfinished({ path, index, before }: CaretPlacement, atEnd: boolean): boolean {
	const parent = path.at(-1);
	// A row without its closing pipe would take the rest of its cells as text in one cell.
	if (atEnd && path.some((node) => node.type === 'table')) return true;
	// A closing fence cannot be typed inside a formatted code block.
	if (parent?.type === 'codeBlock') return true;
	const siblings = parent?.content ?? [];
	// `**bold*` reads as a literal `*` and italic text until its last delimiter arrives.
	if (
		before === '' &&
		siblings[index - 1]?.marks?.length &&
		/[*_~]$/.test(siblings[index - 2]?.text ?? '')
	)
		return true;
	// `- [` and `- [ ]` are a task marker that is missing its space.
	return path.at(-2)?.type === 'listItem' && index === 0 && /^\[[ xX]?\]?$/.test(before);
}

export function parseComposerMarkdown({
	source,
	pastedText,
	caret,
}: ComposerMarkdownRequest): ComposerMarkdownDocument | null {
	if (!isComposerMarkdownSized(source)) return null;
	if (pastedText !== undefined) {
		if (!isMarkdownCandidate(pastedText)) return null;
		let formatted = false;
		marked.walkTokens(marked.lexer(pastedText), (token) => {
			if (isFormattingToken(token)) formatted = true;
		});
		if (!formatted) return null;
	}
	const { ended, ...parsed } = parseBlocks(source);
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
			if (isUnfinished(placement, caret === source.length)) return null;
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
			if (trailing === undefined) return null;
			parsed.selection = trailing;
		}
	}
	return parsed;
}

function jsonNodeSize(node: JSONContent): number {
	if (node.text !== undefined) return node.text.length;
	return node.content ? 2 + node.content.reduce((sum, child) => sum + jsonNodeSize(child), 0) : 1;
}
