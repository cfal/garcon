import type { MarkdownManager } from '@tiptap/markdown';
import type { JSONContent } from '@tiptap/core';

/** Preserves code whitespace and represents line breaks outside code spans. */
export function serializeComposerMarkdown(manager: MarkdownManager, document: JSONContent): string {
	const codeSpan = (text: string): JSONContent => ({ type: 'draftCodeSpan', attrs: { text } });
	const tableCode = (text: string): JSONContent[] => {
		const fragments: JSONContent[] = [];
		let start = 0;
		// GFM tables require an odd pipe escape; an odd literal backslash remains outside code.
		for (const match of text.matchAll(/\\+\|/g)) {
			const slashes = match[0].length - 1;
			if (slashes % 2 === 0) continue;
			const end = match.index + slashes - 1;
			if (end > start) fragments.push(codeSpan(text.slice(start, end)));
			fragments.push({ type: 'text', text: '\\' });
			start = end + 1;
		}
		if (start < text.length) fragments.push(codeSpan(text.slice(start)));
		return fragments;
	};
	const normalize = (node: JSONContent, context: 'table' | 'text'): JSONContent => {
		if (!node.content) return node;
		return {
			...node,
			content: node.content.flatMap((child) => {
				if (child.type === 'text' && child.marks?.some((mark) => mark.type === 'code')) {
					return (child.text ?? '')
						.split(/\r?\n/)
						.flatMap((text, index) => [
							...(index ? [{ type: 'hardBreak' }] : []),
							...(text ? (context === 'table' ? tableCode(text) : [codeSpan(text)]) : []),
						]);
				}
				return [normalize(child, child.type === 'table' ? 'table' : context)];
			}),
		};
	};
	return manager.serialize(normalize(document, 'text'));
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
