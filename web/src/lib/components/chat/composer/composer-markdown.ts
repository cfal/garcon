import { Lexer, type MarkedExtension } from 'marked';
import { createLiteralHtmlMarkdownExtension } from '$lib/components/rich-text/markdown-html-policy.js';

export function hasMarkdownTable(source: string): boolean {
	return Lexer.lex(source).some((token) => token.type === 'table');
}

// Only plain line breaks are interpreted as HTML in a draft.
const draftLineBreaks: MarkedExtension = {
	extensions: [
		{
			name: 'br',
			level: 'inline',
			tokenizer(source) {
				const match = /^<br\s*\/?\s*>/i.exec(source);
				if (match) return { type: 'br', raw: match[0] };
			},
		},
	],
};

export const composerMarkdownExtensions = [createLiteralHtmlMarkdownExtension(), draftLineBreaks];
