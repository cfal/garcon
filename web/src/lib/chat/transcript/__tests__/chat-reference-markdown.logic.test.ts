import { markedKatex } from '@humanspeak/svelte-markdown/extensions/katex';
import { Lexer, Marked, type Token, type TokensList } from 'marked';
import { describe, expect, it } from 'vitest';
import { createLiteralHtmlMarkdownExtension } from '$lib/components/chat/markdown-html-policy.js';
import { createChatReferenceMarkdownExtension } from '../chat-reference-markdown.js';

const CHAT_ID = '1788592720180699';
const SECOND_CHAT_ID = '1788592720180600';

function lex(source: string): { marked: Marked; tokens: TokensList } {
	const marked = new Marked(
		markedKatex({ singleDollarInline: true }),
		createLiteralHtmlMarkdownExtension(),
		createChatReferenceMarkdownExtension(),
	);
	return { marked, tokens: new Lexer(marked.defaults).lex(source) };
}

function collectTokens(marked: Marked, tokens: Token[] | TokensList): Token[] {
	const collected: Token[] = [];
	marked.walkTokens(tokens, (token) => {
		collected.push(token);
	});
	return collected;
}

function chatReferenceIds(source: string): string[] {
	const { marked, tokens } = lex(source);
	return collectTokens(marked, tokens)
		.filter(
			(token): token is Token & { type: 'chatReference'; chatId: unknown } =>
				token.type === 'chatReference' && 'chatId' in token,
		)
		.map((token) => String(token.chatId));
}

describe('createChatReferenceMarkdownExtension', () => {
	it.each([
		CHAT_ID,
		`before ${CHAT_ID}`,
		`${CHAT_ID} after`,
		`(${CHAT_ID})`,
		`${CHAT_ID},`,
		`${CHAT_ID}:`,
		`${CHAT_ID}.`,
	])('recognizes a punctuation- or whitespace-delimited ID in %s', (source) => {
		expect(chatReferenceIds(source)).toEqual([CHAT_ID]);
	});

	it('recognizes multiple references independently', () => {
		expect(chatReferenceIds(`${CHAT_ID}, then ${SECOND_CHAT_ID}.`)).toEqual([
			CHAT_ID,
			SECOND_CHAT_ID,
		]);
	});

	it.each([
		'178859272018069',
		'17885927201806999',
		'0000000000000000',
		'9999999999999999',
		`x${CHAT_ID}`,
		`${CHAT_ID}x`,
		`é${CHAT_ID}`,
		`${CHAT_ID}é`,
		`e\u0301${CHAT_ID}`,
		`${CHAT_ID}\u0301e`,
		`٣${CHAT_ID}`,
		`${CHAT_ID}٣`,
		`_${CHAT_ID}`,
		`${CHAT_ID}_`,
	])('rejects an invalid or word-adjacent candidate in %s', (source) => {
		expect(chatReferenceIds(source)).toEqual([]);
	});

	it.each([
		`\`${CHAT_ID}\``,
		`\`\`\`text\n${CHAT_ID}\n\`\`\``,
		`    ${CHAT_ID}`,
		`[${CHAT_ID}](https://example.com)`,
		`[target](https://example.com/${CHAT_ID})`,
		`<https://example.com/${CHAT_ID}>`,
		`https://example.com/${CHAT_ID}`,
		`www.example.com/${CHAT_ID}`,
		`user${CHAT_ID}@example.com`,
	])('does not claim IDs owned by code or links in %s', (source) => {
		expect(chatReferenceIds(source)).toEqual([]);
	});

	it.each([
		`${CHAT_ID}@example.com`,
		`${CHAT_ID}+updates@example.com`,
		`${CHAT_ID}.updates@example.com`,
		`${CHAT_ID}-updates@example.com`,
	])('preserves a complete GFM email link for %s', (address) => {
		const { marked, tokens } = lex(`Email ${address} now`);
		const collected = collectTokens(marked, tokens);
		const links = collected.filter((token) => token.type === 'link');

		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			raw: address,
			text: address,
			href: `mailto:${address}`,
		});
		expect(collected.some((token) => token.type === 'chatReference')).toBe(false);
	});

	it('coexists with KaTeX, literal XML, tables, lists, and blockquotes', () => {
		const source = [
			`$x$ <garcon-chat-id>${CHAT_ID}</garcon-chat-id>`,
			'',
			`| Chat |\n| --- |\n| ${SECOND_CHAT_ID} |`,
			'',
			`- ${CHAT_ID}`,
			`> ${SECOND_CHAT_ID}`,
		].join('\n');
		const { marked, tokens } = lex(source);
		const tokenTypes = collectTokens(marked, tokens).map((token) => token.type);

		expect(chatReferenceIds(source)).toEqual([CHAT_ID, SECOND_CHAT_ID, CHAT_ID, SECOND_CHAT_ID]);
		expect(tokenTypes).toContain('inlineKatex');
		expect(tokenTypes).not.toContain('html');
	});

	it('leaves large ordinary and digit-dense non-reference input stable', () => {
		const ordinary = Array.from({ length: 200 }, (_, index) => `segment-${index}`).join(' ');
		const digits = '9'.repeat(4_000);
		const ordinaryLex = lex(ordinary);

		expect(chatReferenceIds(ordinary)).toHaveLength(0);
		expect(chatReferenceIds(digits)).toHaveLength(0);
		expect(
			collectTokens(ordinaryLex.marked, ordinaryLex.tokens)
				.map((token) => token.raw)
				.join(''),
		).toContain(ordinary);
	});
});
