import { Blockquote } from '@tiptap/extension-blockquote';
import { Code } from '@tiptap/extension-code';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Document } from '@tiptap/extension-document';
import { Heading } from '@tiptap/extension-heading';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { BulletList } from '@tiptap/extension-list/bullet-list';
import { ListItem } from '@tiptap/extension-list/item';
import { OrderedList } from '@tiptap/extension-list/ordered-list';
import { Table } from '@tiptap/extension-table/table';
import { TableRow } from '@tiptap/extension-table/row';
import { TableCell } from '@tiptap/extension-table/cell';
import { TableHeader } from '@tiptap/extension-table/header';
import Image from '@tiptap/extension-image';
import { TaskList } from '@tiptap/extension-list/task-list';
import { TaskItem } from '@tiptap/extension-list/task-item';
import {
	Bold,
	starInputRegex as boldStarInputRegex,
	underscoreInputRegex as boldUnderscoreInputRegex,
} from '@tiptap/extension-bold';
import {
	Italic,
	starInputRegex as italicStarInputRegex,
	underscoreInputRegex as italicUnderscoreInputRegex,
} from '@tiptap/extension-italic';
import { Strike } from '@tiptap/extension-strike';
import { HardBreak } from '@tiptap/extension-hard-break';
import {
	Extension,
	Mark,
	markInputRule,
	type JSONContent,
	type MarkdownParseHelpers,
	type MarkdownRendererHelpers,
	type MarkdownToken,
} from '@tiptap/core';

// Shared with the editing mark without importing its URL detection and paste plugins into the Worker.
export const composerLinkMarkdown = {
	parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) =>
		helpers.applyMark('link', helpers.parseInline(token.tokens ?? []), {
			href: token.href,
			title: token.title || null,
		}),
	renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers) {
		const href = node.attrs?.href ?? '';
		const title = node.attrs?.title ?? '';
		const text = helpers.renderChildren(node);
		return title ? `[${text}](${href} "${title}")` : `[${text}](${href})`;
	},
};

const CodecLink = Mark.create({
	name: 'link',
	priority: 1000,
	addAttributes: () => ({ href: { default: null }, title: { default: null } }),
	...composerLinkMarkdown,
});

// The stock renderer always writes a three-backtick fence, which a body line of three or more
// backticks would close early. The serializer hands code blocks to this renderer instead.
export const DRAFT_CODE_BLOCK = 'draftCodeBlock';
const DraftCodeBlock = Extension.create({
	name: DRAFT_CODE_BLOCK,
	renderMarkdown(node) {
		const text = typeof node.attrs?.text === 'string' ? node.attrs.text : '';
		const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
		const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
		const fence = '`'.repeat(Math.max(3, longest + 1));
		return `${fence}${language}\n${text}\n${fence}`;
	},
});

// Emphasis keeps the delimiter it was written with, so an identifier such as `__init__.py` is
// not rewritten to `**init**.py` when its block is edited.
function writtenDelimiter(name: string, stock: string, alternate: string) {
	return {
		addAttributes: () => ({ delimiter: { default: null, rendered: false } }),
		parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) =>
			helpers.applyMark(
				name,
				helpers.parseInline(token.tokens ?? []),
				token.raw?.startsWith(alternate) && !token.raw.startsWith(stock)
					? { delimiter: alternate }
					: undefined,
			),
		renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers) {
			const delimiter = node.attrs?.delimiter === alternate ? alternate : stock;
			return `${delimiter}${helpers.renderChildren(node)}${delimiter}`;
		},
	};
}

const DraftBold = Bold.extend({
	...writtenDelimiter('bold', '**', '__'),
	addInputRules() {
		return [
			markInputRule({ find: boldStarInputRegex, type: this.type }),
			markInputRule({
				find: boldUnderscoreInputRegex,
				type: this.type,
				getAttributes: { delimiter: '__' },
			}),
		];
	},
});

const DraftItalic = Italic.extend({
	...writtenDelimiter('italic', '*', '_'),
	addInputRules() {
		return [
			markInputRule({ find: italicStarInputRegex, type: this.type }),
			markInputRule({
				find: italicUnderscoreInputRegex,
				type: this.type,
				getAttributes: { delimiter: '_' },
			}),
		];
	},
});

const DraftStrike = Strike.extend(writtenDelimiter('strike', '~~', '~'));

// Records a break written as `<br>`, which prose keeps as written and a table cell requires.
const DraftHardBreak = HardBreak.extend({
	addAttributes: () => ({ html: { default: false, rendered: false } }),
	parseMarkdown: (token) => ({
		type: 'hardBreak',
		...(token.raw?.startsWith('<') ? { attrs: { html: true } } : {}),
	}),
});

// Draft resources remain visible as text without fetching or navigating them.
const DraftImage = Image.extend({
	renderHTML({ node }) {
		return ['span', { class: 'draft-image' }, node.attrs.alt || 'Image'];
	},
});

// Unpadded cells preserve code whitespace and keep serialization proportional to the draft.
const DraftTable = Table.extend({
	renderMarkdown(node, helpers) {
		const rows = node.content ?? [];
		if (!rows.length) return '';
		const renderRow = (cells: NonNullable<typeof node.content>) =>
			`| ${cells
				.map((cell) =>
					helpers
						.renderChildren(cell.content ?? [], '\n')
						.replace(/ {2}\r?\n|\r?\n/g, '<br>')
						.trim()
						.replace(/\\.|\|/g, (match) => (match === '|' ? '\\|' : match)),
				)
				.join(' | ')} |`;
		const header = rows[0].content ?? [];
		const delimiter = header.map((cell) => {
			switch (cell.attrs?.align) {
				case 'left':
					return ':---';
				case 'right':
					return '---:';
				case 'center':
					return ':---:';
				default:
					return '---';
			}
		});
		return [
			renderRow(header),
			`| ${delimiter.join(' | ')} |`,
			...rows.slice(1).map((row) => renderRow(row.content ?? [])),
		].join('\n');
	},
});

export function composerMarkdownCodecExtensions() {
	return [
		Blockquote,
		BulletList,
		Code,
		CodeBlock,
		Document,
		Heading,
		HorizontalRule,
		ListItem,
		CodecLink,
		OrderedList,
		Paragraph,
		Text,
		DraftBold,
		DraftItalic,
		DraftStrike,
		DraftHardBreak,
		DraftCodeBlock,
		TableCell.extend({ content: 'paragraph' }),
		TableHeader.extend({ content: 'paragraph' }),
		TableRow,
		DraftTable.configure({ resizable: false }),
		DraftImage.configure({ inline: true }),
		TaskList,
		TaskItem.configure({ nested: true }),
	];
}
