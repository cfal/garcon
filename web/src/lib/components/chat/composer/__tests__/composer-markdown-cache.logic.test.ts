import { describe, expect, it } from 'vitest';
import { getSchema, type JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { ComposerMarkdownCache } from '../composer-markdown-cache.js';
import { composerMarkdownEditorExtensions } from '../composer-markdown-extensions.js';
import { configureComposerMarkdown, serializeComposerMarkdown } from '../composer-markdown.js';
import { parseComposerMarkdown } from '../composer-markdown-parser.js';

const extensions = composerMarkdownEditorExtensions();
const schema = getSchema(extensions);
const manager = new MarkdownManager({ extensions, markedOptions: { breaks: true } });
configureComposerMarkdown(manager);
const serialize = (doc: JSONContent) => serializeComposerMarkdown(manager, doc);
const nodes = (source: string) => {
	const doc = schema.nodeFromJSON(parseComposerMarkdown({ source })!.document);
	return Array.from({ length: doc.childCount }, (_, index) => doc.child(index));
};

describe('synchronous Markdown identity cache', () => {
	it.each([
		'> abc\n> continuation\n\n- first\n- second',
		'# title\n\nparagraph with __init__.py &lt; [**code**](https://example.test)',
		'| A | B |\n| :--- | ---: |\n| **one**<br>two | ` a  b ` |\n| a\\|b | \\ |',
		'| A |\n| --- |\n| `` ` `` and `\\\\|` |',
		'> | A |\n> | --- |\n> | **nested** |',
		'- [ ] task\n\n  > quote\n\n- [x] done',
		'```js\n``` inside\n````\n\n![alt](https://example.test/image.png)',
		'private \ue000 text\n\n| A |\n| --- |\n| \ue001 &lt; |',
		'\ue000\n\n[my_var](https://example.test/\ue000)',
		'\ue000\n\n![my_var](https://example.test/\ue000)',
		'[label](https://example.test/\ue000 "title\ue001")\n\nmy_var',
		'![alt\ue002](https://example.test/\ue000 "title\ue001")\n\nmy_var',
	])('matches the uncached codec: %s', (source) => {
		const content = nodes(source);
		const cache = new ComposerMarkdownCache(serialize);
		const expected = serialize({ type: 'doc', content: content.map((node) => node.toJSON()) });
		expect(cache.run(content)).toBe(expected);
		expect(cache.run(content)).toBe(expected);
	});

	it('normalizes repeated empty paragraphs exactly like the uncached run', () => {
		const empty = schema.nodes.paragraph.create();
		const content = [empty, empty, ...nodes('body'), empty, empty];
		expect(new ComposerMarkdownCache(serialize).run(content)).toBe(
			serialize({ type: 'doc', content: content.map((node) => node.toJSON()) }),
		);
	});
	it.each(['break', 'space', 'nonbreaking space'])(
		'preserves a whitespace-only %s block in a run',
		(kind) => {
			let inline = schema.nodes.hardBreak.create();
			if (kind !== 'break') inline = schema.text(kind === 'space' ? ' ' : '\u00a0');
			const content = [
				...nodes('before'),
				schema.nodes.paragraph.create(null, inline),
				...nodes('after'),
			];
			expect(new ComposerMarkdownCache(serialize).run(content)).toBe(
				serialize({ type: 'doc', content: content.map((node) => node.toJSON()) }),
			);
		},
	);
	it('uses the whole-run escaping policy when private-use sentinels are exhausted', () => {
		const privateUse = String.fromCharCode(...Array.from({ length: 0x1900 }, (_, i) => 0xe000 + i));
		const content = [
			...nodes('my_var'),
			schema.nodes.paragraph.create(null, schema.text(privateUse)),
		];
		expect(new ComposerMarkdownCache(serialize).run(content)).toBe(
			serialize({ type: 'doc', content: content.map((node) => node.toJSON()) }),
		);
	});

	it('shares the whole-run policy when resource attributes exhaust the sentinel space', () => {
		const privateUse = String.fromCharCode(...Array.from({ length: 0x1900 }, (_, i) => 0xe000 + i));
		const content = [
			...nodes('my_var'),
			schema.nodes.paragraph.create(
				null,
				schema.text('label', [
					schema.marks.link.create({ href: 'https://example.test/' + privateUse.slice(0, 0xc80) }),
				]),
			),
			schema.nodes.paragraph.create(
				null,
				schema.nodes.image.create({ src: 'https://example.test/' + privateUse.slice(0xc80) }),
			),
		];
		const cache = new ComposerMarkdownCache(serialize);
		const expected = serialize({ type: 'doc', content: content.map((node) => node.toJSON()) });
		expect(cache.run(content)).toBe(expected);
		expect(cache.run(content)).toBe(expected);
	});

	it('reserializes only changed rows and blocks, including header alignment and undo', () => {
		let calls = 0;
		const cache = new ComposerMarkdownCache((doc) => {
			calls++;
			return serialize(doc);
		});
		const content = nodes('before\n\n| A |\n| --- |\n| one |\n| two |\n\nafter');
		const original = cache.run(content);
		expect(calls).toBe(5);
		const table = content[1];
		const editedRow = schema.nodes.tableRow.create(null, [
			schema.nodes.tableCell.create(
				null,
				schema.nodes.paragraph.create(null, schema.text('changed')),
			),
		]);
		const edited = [...content];
		edited[1] = table.copy(
			schema.nodes.table.create(null, [table.child(0), editedRow, table.child(2)]).content,
		);
		expect(cache.run(edited)).toBe(
			serialize({ type: 'doc', content: edited.map((node) => node.toJSON()) }),
		);
		expect(calls).toBe(6);
		expect(cache.run(content)).toBe(original);
		expect(calls).toBe(6);
		const header = table.child(0).child(0);
		const aligned = schema.nodes.tableRow.create(
			null,
			header.type.create({ ...header.attrs, align: 'right' }, header.content),
		);
		edited[1] = schema.nodes.table.create(null, [aligned, editedRow]);
		expect(cache.run(edited)).toBe(
			serialize({ type: 'doc', content: edited.map((node) => node.toJSON()) }),
		);
		expect(calls).toBe(7);
	});
});
