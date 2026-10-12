import type { MarkdownManager } from '@tiptap/markdown';
import type { JSONContent } from '@tiptap/core';
import { DRAFT_CODE_BLOCK } from './composer-markdown-extensions.js';
import { createTextProtection, type TextProtection } from './composer-markdown-text.js';

type Mark = NonNullable<JSONContent['marks']>[number];

function draftText(node: JSONContent): string {
	return (node.text ?? '') + (node.content ?? []).map(draftText).join('');
}

function codeSpan(text: string): string {
	const runs = new Set((text.match(/`+/g) ?? []).map((run) => run.length));
	let length = 1;
	while (runs.has(length)) length++;
	const fence = '`'.repeat(length);
	// CommonMark removes one edge space unless the entire span is spaces.
	const padding =
		text.startsWith('`') ||
		text.endsWith('`') ||
		(text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text))
			? ' '
			: '';
	return `${fence}${padding}${text}${padding}${fence}`;
}

// Marked autolinks bare addresses; writing them back as `[url](url)` would double them.
function isAutolink(text: string, mark: Mark): boolean {
	const href = mark.attrs?.href;
	return (
		!mark.attrs?.title && (href === text || href === `mailto:${text}` || href === `http://${text}`)
	);
}

function isEmptyParagraph(node: JSONContent | undefined): boolean {
	return node?.type === 'paragraph' && !node.content?.length;
}

/**
 * Serializes with the characters, code whitespace, and line breaks the user wrote: prose keeps
 * its literal punctuation, code spans keep their marks, and bare links stay bare.
 */
export function serializeComposerMarkdown(manager: MarkdownManager, document: JSONContent): string {
	const protection = createTextProtection(draftText(document));
	const output = manager.serialize(normalize(document, false, protection));
	return protection ? protection.restore(output) : output;
}

function normalize(
	node: JSONContent,
	table: boolean,
	protection: TextProtection | null,
): JSONContent {
	if (!node.content) return node;
	const content: JSONContent[] = [];
	const lineBreak = (marks?: Mark[]): JSONContent =>
		// Table cells keep the node so the table renderer can write `<br>`.
		table ? { type: 'hardBreak' } : { type: 'text', text: '\n', ...(marks ? { marks } : {}) };
	node.content.forEach((child, index) => {
		const previous = node.content?.[index - 1];
		if (child.type === 'hardBreak') {
			content.push(lineBreak(child.marks));
		} else if (child.type === 'codeBlock') {
			content.push({
				type: DRAFT_CODE_BLOCK,
				attrs: { language: child.attrs?.language ?? '', text: draftText(child) },
			});
		} else if (child.type !== 'text') {
			// The serializer marks a repeated empty paragraph with a literal `&nbsp;`.
			if (isEmptyParagraph(child) && isEmptyParagraph(previous)) return;
			content.push(normalize(child, table || child.type === 'table', protection));
		} else if (protection) {
			content.push(
				...protectText(child, index === 0 || previous?.type === 'hardBreak', table, protection).map(
					(fragment) => (fragment.type === 'hardBreak' ? lineBreak(fragment.marks) : fragment),
				),
			);
		} else {
			content.push(child);
		}
	});
	return { ...node, content };
}

function protectText(
	node: JSONContent,
	lineStart: boolean,
	table: boolean,
	protection: TextProtection,
): JSONContent[] {
	const text = node.text ?? '';
	const marks = node.marks ?? [];
	const withMarks = (value: string, kept: Mark[]): JSONContent => ({
		type: 'text',
		text: value,
		...(kept.length ? { marks: kept } : {}),
	});
	if (marks.some((mark) => mark.type === 'code')) {
		// Written as text so marks such as a link around the code survive.
		const kept = marks.filter((mark) => mark.type !== 'code');
		const code = (value: string) => withMarks(protection.verbatim(codeSpan(value)), kept);
		return text
			.split(/\r?\n/)
			.flatMap((line, index) => [
				...(index ? [{ type: 'hardBreak', ...(kept.length ? { marks: kept } : {}) }] : []),
				...(line ? (table ? tableCode(line, code, (value) => withMarks(value, kept)) : [code(line)]) : []),
			]);
	}
	const link = marks.find((mark) => mark.type === 'link');
	if (link && isAutolink(text, link)) {
		return [withMarks(protection.verbatim(text), marks.filter((mark) => mark !== link))];
	}
	return [withMarks(protection.prose(text, { lineStart, link: Boolean(link) }), marks)];
}

function tableCode(
	text: string,
	code: (value: string) => JSONContent,
	plain: (value: string) => JSONContent,
): JSONContent[] {
	const fragments: JSONContent[] = [];
	let start = 0;
	// GFM tables require an odd pipe escape; an odd literal backslash remains outside code.
	for (const match of text.matchAll(/\\+\|/g)) {
		const slashes = match[0].length - 1;
		if (slashes % 2 === 0) continue;
		const end = match.index + slashes - 1;
		if (end > start) fragments.push(code(text.slice(start, end)));
		fragments.push(plain('\\'));
		start = end + 1;
	}
	if (start < text.length) fragments.push(code(text.slice(start)));
	return fragments;
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
