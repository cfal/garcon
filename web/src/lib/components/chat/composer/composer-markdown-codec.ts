import { MarkdownManager } from '@tiptap/markdown';
import type { JSONContent } from '@tiptap/core';
import { composerMarkdownCodecExtensions } from './composer-markdown-codec-extensions.js';
import { configureComposerMarkdown, serializeComposerMarkdown } from './composer-markdown.js';

// One configured codec per realm; the transcript renderer uses its separate Marked dependency.
const manager = new MarkdownManager({
	extensions: composerMarkdownCodecExtensions(),
	markedOptions: { breaks: true },
});
configureComposerMarkdown(manager);

export const composerMarkdownCodec = {
	parse: (source: string) => manager.parse(source),
	lex: (source: string) => manager.instance.lexer(source),
	serialize: (document: JSONContent) => serializeComposerMarkdown(manager, document),
};
