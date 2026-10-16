import { describe, expect, it } from 'vitest';
import { flattenExtensions, getSchema, sortExtensions } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { MarkdownManager } from '@tiptap/markdown';
import { composerMarkdownEditorExtensions } from '../composer-markdown-extensions.js';
import { composerMarkdownCodec } from '../composer-markdown-codec.js';
import { configureComposerMarkdown, serializeComposerMarkdown } from '../composer-markdown.js';

describe('composer schema and codec boundary', () => {
	it('retains extension precedence without the inert kit wrappers', () => {
		expect(
			sortExtensions(flattenExtensions(composerMarkdownEditorExtensions())).map(
				(extension) => extension.name,
			),
		).toEqual([
			'link',
			'paragraph',
			'listItemBranchingDeleteKeymap',
			'taskItemBranchingDeleteKeymap',
			'blockquote',
			'bulletList',
			'code',
			'codeBlock',
			'doc',
			'dropCursor',
			'gapCursor',
			'heading',
			'undoRedo',
			'horizontalRule',
			'listItem',
			'listKeymap',
			'orderedList',
			'text',
			'bold',
			'italic',
			'strike',
			'hardBreak',
			'draftCodeBlock',
			'tableCell',
			'tableHeader',
			'tableRow',
			'table',
			'image',
			'taskList',
			'taskItem',
		]);
	});
	it('permits only one inline paragraph per GFM cell', () => {
		const schema = getSchema(composerMarkdownEditorExtensions());
		const paragraph = schema.nodes.paragraph.create();
		for (const cell of [schema.nodes.tableCell, schema.nodes.tableHeader]) {
			expect(cell.validContent(Fragment.from(paragraph))).toBe(true);
			expect(cell.validContent(Fragment.from([paragraph, paragraph]))).toBe(false);
			expect(cell.validContent(Fragment.from(schema.nodes.heading.create()))).toBe(false);
		}
	});
	it.each([
		'[**bold** and ` a  b `](<https://example.test/a b> "title")',
		'__init__.py &lt; https://example.test\nsecond line',
		'| A | B |\n| :--- | ---: |\n| [link](https://example.test) | one<br>two |',
		'- [ ] **task**\n\n  > *quote*',
	])('shares parse and serialize semantics with editing extensions: %s', (source) => {
		const editing = new MarkdownManager({
			extensions: composerMarkdownEditorExtensions(),
			markedOptions: { breaks: true },
		});
		configureComposerMarkdown(editing);
		const document = composerMarkdownCodec.parse(source);
		expect(document).toEqual(editing.parse(source));
		expect(composerMarkdownCodec.serialize(document)).toBe(
			serializeComposerMarkdown(editing, document),
		);
	});
});
