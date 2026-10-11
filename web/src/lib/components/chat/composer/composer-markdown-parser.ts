import { MarkdownManager } from '@tiptap/markdown';
import type { JSONContent } from '@tiptap/core';
import { composerMarkdownEditorExtensions } from './composer-markdown-extensions.js';
import { configureComposerMarkdown } from './composer-markdown.js';
import {
	isComposerMarkdownSized,
	isMarkdownTableCandidate,
	MAX_COMPOSER_MARKDOWN_NODES,
} from './composer-markdown-limits.js';

const manager = new MarkdownManager({
	extensions: composerMarkdownEditorExtensions(),
	markedOptions: { breaks: true },
});
configureComposerMarkdown(manager);
const marked = manager.instance;

export interface ComposerMarkdownRequest {
	source: string;
	pastedText?: string;
}

export function parseComposerMarkdown({
	source,
	pastedText,
}: ComposerMarkdownRequest): JSONContent | null {
	if (!isComposerMarkdownSized(source)) return null;
	if (pastedText !== undefined) {
		if (!isMarkdownTableCandidate(pastedText)) return null;
		let hasTable = false;
		marked.walkTokens(marked.lexer(pastedText), (token) => {
			if (token.type === 'table') hasTable = true;
		});
		if (!hasTable) return null;
	}
	const document = manager.parse(source);
	const pending = [document];
	let count = 0;
	while (pending.length) {
		if (++count > MAX_COMPOSER_MARKDOWN_NODES) return null;
		pending.push(...(pending.pop()?.content ?? []));
	}
	return document;
}
