import { describe, expect, it } from 'vitest';
import { MarkdownManager } from '@tiptap/markdown';
import { getSchema, type JSONContent } from '@tiptap/core';
import { parseComposerMarkdown } from '../composer-markdown-parser.js';
import { composerMarkdownEditorExtensions } from '../composer-markdown-extensions.js';
import { MAX_COMPOSER_MARKDOWN_LENGTH } from '../composer-markdown-limits.js';
import { configureComposerMarkdown, serializeComposerMarkdown } from '../composer-markdown.js';

const table = '| Check | Example |\n| - | - |\n| **Ready** | First<br>Second |';
function nodes(document: JSONContent): JSONContent[] {
	return [document, ...(document.content ?? []).flatMap(nodes)];
}

describe('composer Markdown parsing', () => {
	it.each([
		table,
		table
			.split('\n')
			.map((line) => `> ${line}`)
			.join('\n'),
		'- Review\n\n' +
			table
				.split('\n')
				.map((line) => `  ${line}`)
				.join('\n'),
	])('detects tables recursively and preserves editable formatting: %s', (source) => {
		const document = parseComposerMarkdown({ source, pastedText: source });
		expect(document).not.toBeNull();
		const content = nodes(document!);
		expect(content.some((node) => node.type === 'table')).toBe(true);
		expect(content.some((node) => node.type === 'hardBreak')).toBe(true);
		expect(content.some((node) => node.marks?.some((mark) => mark.type === 'bold'))).toBe(true);
	});
	it('does not format unrelated clipboard text in an existing table draft', () => {
		expect(parseComposerMarkdown({ source: table + '\nnotes', pastedText: 'notes' })).toBeNull();
	});
	it('rejects oversized documents and documents with too many nodes', () => {
		expect(
			parseComposerMarkdown({ source: 'a'.repeat(MAX_COMPOSER_MARKDOWN_LENGTH + 1) }),
		).toBeNull();
		expect(parseComposerMarkdown({ source: '- a\n'.repeat(700) })).toBeNull();
	});
	it('does not mistake fenced table syntax for a table', () => {
		const source = '```\n' + table + '\n```';
		expect(parseComposerMarkdown({ source, pastedText: source })).toBeNull();
	});
	it.each([
		'Hello ![Icon](https://example.test/icon.png) world',
		'| Image | Value |\n| - | - |\n| ![Icon](https://example.test/icon.png) | one |',
	])('builds valid inline image documents without resource elements: %s', (source) => {
		const extensions = composerMarkdownEditorExtensions();
		const document = parseComposerMarkdown({ source })!;
		expect(() => getSchema(extensions).nodeFromJSON(document).check()).not.toThrow();
		expect(new MarkdownManager({ extensions }).serialize(document)).toContain(
			'![Icon](https://example.test/icon.png)',
		);
	});
	it('keeps raw HTML literal and preserves breaks, escaped pipes, and links on serialization', () => {
		const source =
			table +
			'\n\n<script>synthetic</script>\n\n<!-- keep -->\n\n[Link](https://example.test)\n\n![Alt](https://example.test/image.png)';
		const parsed = parseComposerMarkdown({ source })!;
		const manager = new MarkdownManager({ extensions: composerMarkdownEditorExtensions() });
		const serialized = manager.serialize(parsed);
		expect(serialized).toContain('First<br>Second');
		expect(serialized).toContain('synthetic');
		expect(serialized).toContain('keep');
		expect(serialized).toContain('https://example.test/image.png');
		const escaped = parseComposerMarkdown({
			source: '| A | B |\n| - | - |\n| one\\|two | three |',
		})!;
		expect(manager.serialize(escaped)).toContain('one\\|two');
	});
	it('preserves code spaces and avoids multiplying long cells across every row', () => {
		const source =
			'| Code | Note |\n| --- | --- |\n| `a  b` | original |\n| ' +
			'x'.repeat(10_000) +
			' | note |\n' +
			'| short | note |\n'.repeat(200);
		const document = parseComposerMarkdown({ source })!;
		const manager = new MarkdownManager({ extensions: composerMarkdownEditorExtensions() });
		const output = manager.serialize(document);
		expect(output).toContain('`a  b`');
		expect(output.length).toBeLessThan(source.length + 100);
	});
	it('preserves separate paragraphs in an edited table cell', () => {
		const document = parseComposerMarkdown({ source: table })!;
		const cell = nodes(document).find((node) => node.type === 'tableCell')!;
		cell.content = ['first', 'second'].map((text) => ({
			type: 'paragraph',
			content: [{ type: 'text', text }],
		}));
		const manager = new MarkdownManager({ extensions: composerMarkdownEditorExtensions() });
		expect(manager.serialize(document)).toContain('first<br>second');
	});
	it.each([
		'a\nb',
		'a\n',
		'\na',
		' a ',
		'  ',
		'`edge`',
		'a``b`c```d',
		'a\n`b`\n c ',
		'a|b',
		'a\\|b',
		'a\\\\|b',
	])('round trips edited code text in table cells: %s', (text) => {
		const document = parseComposerMarkdown({ source: table })!;
		const cell = nodes(document).find((node) => node.type === 'tableCell')!;
		cell.content = [
			{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'code' }] }] },
		];
		const manager = new MarkdownManager({
			extensions: composerMarkdownEditorExtensions(),
			markedOptions: { breaks: true },
		});
		configureComposerMarkdown(manager);
		const output = manager.parse(serializeComposerMarkdown(manager, document));
		const paragraph = nodes(output).find((node) => node.type === 'tableCell')!.content![0];
		expect(
			paragraph.content!.map((node) => (node.type === 'hardBreak' ? '\n' : node.text)).join(''),
		).toBe(text);
	});
});
