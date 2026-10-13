import { MarkdownManager } from '@tiptap/markdown';
import type { JSONContent } from '@tiptap/core';
import { composerMarkdownEditorExtensions } from './composer-markdown-extensions.js';
import { configureComposerMarkdown, serializeComposerMarkdown } from './composer-markdown.js';
import { joinComposerMarkdownBlocks, type ComposerMarkdownBlock } from './composer-markdown-blocks.js';
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
}

export interface ComposerMarkdownDocument {
	document: JSONContent;
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
function parseBlocks(source: string): ComposerMarkdownDocument {
	const content: JSONContent[] = [];
	const sources: (string | null)[] = [];
	let leading = '';
	let lexed = '';
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
			continue;
		}
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
	};
}

export function parseComposerMarkdown({
	source,
	pastedText,
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
	const parsed = parseBlocks(source);
	const pending = [parsed.document];
	let count = 0;
	while (pending.length) {
		if (++count > MAX_COMPOSER_MARKDOWN_NODES) return null;
		pending.push(...(pending.pop()?.content ?? []));
	}
	return parsed;
}
