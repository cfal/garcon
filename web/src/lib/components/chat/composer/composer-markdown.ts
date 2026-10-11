import type { MarkdownManager } from '@tiptap/markdown';
import type { JSONContent } from '@tiptap/core';

/** Preserves code whitespace and represents line breaks outside code spans. */
export function serializeComposerMarkdown(manager: MarkdownManager, document: JSONContent): string {
	const normalize = (node: JSONContent): JSONContent => {
		if (!node.content) return node;
		return {
			...node,
			content: node.content.flatMap((child) => {
				if (child.type === 'text' && child.marks?.some((mark) => mark.type === 'code')) {
					return (child.text ?? '')
						.split(/\r?\n/)
						.flatMap((text, index) => [
							...(index ? [{ type: 'hardBreak' }] : []),
							...(text ? [{ type: 'draftCodeSpan', attrs: { text } }] : []),
						]);
				}
				return [normalize(child)];
			}),
		};
	};
	return manager.serialize(normalize(document));
}

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
