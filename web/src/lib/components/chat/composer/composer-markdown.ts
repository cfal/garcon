import type { MarkdownManager } from '@tiptap/markdown';

/** Keeps draft HTML visible as text, except for plain line breaks. */
export function configureComposerMarkdown(manager: MarkdownManager): void {
	const tag = manager.instance.Lexer.rules.inline.gfm.tag;
	manager.instance.use({
		tokenizer: { html: () => undefined },
		extensions: [
			{
				name: 'text',
				level: 'inline',
				tokenizer(source) {
					const match = tag.exec(source);
					if (match) return { type: 'text', raw: match[0], text: match[0] };
				},
			},
			{
				name: 'br',
				level: 'inline',
				tokenizer(source) {
					const match = /^<br\s*\/?\s*>/i.exec(source);
					if (match) return { type: 'br', raw: match[0] };
				},
			},
		],
	});
}
