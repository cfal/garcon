import { markedKatex } from '@humanspeak/svelte-markdown/extensions/katex';
import { Lexer, Marked, type Token, type TokensList } from 'marked';
import { describe, expect, it } from 'vitest';
import { createLiteralHtmlMarkdownExtension } from '../markdown-html-policy';

function lex(source: string): { marked: Marked; tokens: TokensList } {
	const marked = new Marked(
		markedKatex({ singleDollarInline: true }),
		createLiteralHtmlMarkdownExtension(),
	);
	return {
		marked,
		tokens: new Lexer(marked.defaults).lex(source),
	};
}

function collectTokens(marked: Marked, tokens: Token[] | TokensList): Token[] {
	const collected: Token[] = [];
	marked.walkTokens(tokens, (token) => {
		collected.push(token);
	});
	return collected;
}

describe('createLiteralHtmlMarkdownExtension', () => {
	it.each(['Promise<void>', 'Vec<Vec<u8>>', 'Result<T, Error>'])(
		'reclassifies generic-like HTML in %s as text',
		(source) => {
			const { marked, tokens } = lex(source);
			const collected = collectTokens(marked, tokens);

			expect(collected.some((token) => token.type === 'html')).toBe(false);
			expect(
				collected
					.filter((token) => token.type === 'text')
					.map((token) => token.raw)
					.join(''),
			).toBe(source);
		},
	);

	it('routes block HTML through ordinary Markdown parsing', () => {
		const source = '<config>\n  <item name="primary" />\n</config>';
		const { marked, tokens } = lex(source);
		const collected = collectTokens(marked, tokens);

		expect(tokens[0]?.type).toBe('paragraph');
		expect(collected.some((token) => token.type === 'html')).toBe(false);
		expect(collected.map((token) => token.raw).join('')).toContain('<item name="primary" />');
	});

	it.each(['<!-- hidden -->', 'Before <!-- hidden --> after'])(
		'keeps complete HTML comments as HTML tokens for %s',
		(source) => {
			const { marked, tokens } = lex(source);

			expect(collectTokens(marked, tokens).some((token) => token.type === 'html')).toBe(true);
		},
	);

	it('limits block HTML comment tokens to complete comments', () => {
		const complete = lex('<!-- hidden -->Visible Promise<void>');
		const unterminated = lex('<!-- hidden\n\nVisible Promise<void>');

		expect(complete.tokens[0]).toMatchObject({ type: 'html', raw: '<!-- hidden -->' });
		expect(collectTokens(complete.marked, complete.tokens).map((token) => token.raw)).toContain(
			'Visible Promise<void>',
		);
		expect(collectTokens(unterminated.marked, unterminated.tokens)).not.toContainEqual(
			expect.objectContaining({ type: 'html' }),
		);
	});

	it('preserves KaTeX tokenization containing tag-like text', () => {
		const { marked, tokens } = lex('$a<b>c$');
		const types = collectTokens(marked, tokens).map((token) => token.type);

		expect(types).toContain('inlineKatex');
		expect(types).not.toContain('html');
	});

	it('preserves autolink, code, and escape tokenization', () => {
		const { marked, tokens } = lex(
			'<https://example.com> <user@example.com> `Promise<void>` \\<void>\n\n```ts\nPromise<void>\n```',
		);
		const types = collectTokens(marked, tokens).map((token) => token.type);

		expect(types).toContain('link');
		expect(types).toContain('codespan');
		expect(types).toContain('escape');
		expect(types).toContain('code');
		expect(types).not.toContain('html');
	});
});
