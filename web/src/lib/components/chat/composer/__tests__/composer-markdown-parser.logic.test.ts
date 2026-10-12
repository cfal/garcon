import { describe, expect, it } from 'vitest';
import { MarkdownManager } from '@tiptap/markdown';
import { getSchema, type JSONContent } from '@tiptap/core';
import {
	parseComposerMarkdown,
	serializeComposerMarkdownPaste,
} from '../composer-markdown-parser.js';
import {
	joinComposerMarkdownBlocks,
	planComposerMarkdownBlocks,
} from '../composer-markdown-blocks.js';
import { composerMarkdownEditorExtensions } from '../composer-markdown-extensions.js';
import {
	isMarkdownCandidate,
	isMarkdownTableCandidate,
	MAX_COMPOSER_MARKDOWN_LENGTH,
} from '../composer-markdown-limits.js';
import { configureComposerMarkdown, serializeComposerMarkdown } from '../composer-markdown.js';

const table = '| Check | Example |\n| - | - |\n| **Ready** | First<br>Second |';
function nodes(document: JSONContent): JSONContent[] {
	return [document, ...(document.content ?? []).flatMap(nodes)];
}
function parseDocument(source: string): JSONContent {
	return parseComposerMarkdown({ source })!.document;
}
function editingManager(): MarkdownManager {
	const manager = new MarkdownManager({
		extensions: composerMarkdownEditorExtensions(),
		markedOptions: { breaks: true },
	});
	configureComposerMarkdown(manager);
	return manager;
}
// Serializes the way the editor does after `edit` changes the parsed top-level nodes.
function serializeAfterEdit(
	source: string,
	edit: (content: JSONContent[]) => JSONContent[],
	equals: (a: JSONContent, b: JSONContent) => boolean = (a, b) => a === b,
) {
	const { document, sources } = parseComposerMarkdown({ source })!;
	const original = document.content ?? [];
	const manager = editingManager();
	return joinComposerMarkdownBlocks(
		planComposerMarkdownBlocks(original, sources, edit([...original]), equals),
		original.length,
		(content) => serializeComposerMarkdown(manager, { type: 'doc', content }),
	);
}
function editFirstCell(table: JSONContent, text: string): JSONContent {
	const edited: JSONContent = structuredClone(table);
	const cell = nodes(edited).find((node) => node.type === 'tableCell')!;
	cell.content = [{ type: 'paragraph', content: [{ type: 'text', text }] }];
	return edited;
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
		const parsed = parseComposerMarkdown({ source, pastedText: source });
		expect(parsed).not.toBeNull();
		const content = nodes(parsed!.document);
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
		const content = nodes(parseComposerMarkdown({ source, pastedText: source })!.document);
		expect(content.some((node) => node.type === 'codeBlock')).toBe(true);
		expect(content.some((node) => node.type === 'table')).toBe(false);
	});
	it.each([
		['bold text', 'Ship the **first** change', 'bold'],
		['italic text', 'Ship the *first* change', 'italic'],
		['inline code', 'Run `bun test` first', 'code'],
	])('formats pasted %s', (_name, source, mark) => {
		const parsed = parseComposerMarkdown({ source, pastedText: source });
		expect(
			nodes(parsed!.document).some((node) => node.marks?.some((entry) => entry.type === mark)),
		).toBe(true);
	});
	it.each([
		['a numbered list', '1. first\n2. second', 'orderedList'],
		['a bullet list', '- first\n- second', 'bulletList'],
		['a task list', '- [ ] first\n- [x] second', 'taskList'],
		['a heading', '## Plan\n\nnotes', 'heading'],
		['a block quote', '> quoted', 'blockquote'],
		['a fenced code block', '```ts\nconst a = 1;\n```', 'codeBlock'],
	])('formats pasted %s', (_name, source, type) => {
		const parsed = parseComposerMarkdown({ source, pastedText: source });
		expect(nodes(parsed!.document).some((node) => node.type === type)).toBe(true);
	});
	it.each([
		['plain prose', 'plain notes\nwith two lines'],
		['identifiers and paths', 'my_var in ~/cfg and C:\\Users\\me'],
		['a bare link', 'see https://example.test/a_b for details'],
		['spaced operators', '2 * 3 * 4 and a _ b'],
		['indented text', '    indented continuation\n    of a log line'],
		['a divider', 'above\n\n---\n\nbelow'],
	])('leaves pasted %s in the plain editor', (_name, source) => {
		expect(parseComposerMarkdown({ source, pastedText: source })).toBeNull();
	});
	it.each([
		'Hello ![Icon](https://example.test/icon.png) world',
		'| Image | Value |\n| - | - |\n| ![Icon](https://example.test/icon.png) | one |',
		'intro\n\n![Icon](https://example.test/icon.png)\n\n> ![Icon](https://example.test/icon.png)\n\n- ![Icon](https://example.test/icon.png)',
	])('builds valid inline image documents without resource elements: %s', (source) => {
		const extensions = composerMarkdownEditorExtensions();
		const document = parseDocument(source);
		expect(() => getSchema(extensions).nodeFromJSON(document).check()).not.toThrow();
		expect(new MarkdownManager({ extensions }).serialize(document)).toContain(
			'![Icon](https://example.test/icon.png)',
		);
	});
	it('keeps raw HTML literal and preserves breaks, escaped pipes, and links on serialization', () => {
		const source =
			table +
			'\n\n<script>synthetic</script>\n\n<!-- keep -->\n\n[Link](https://example.test)\n\n![Alt](https://example.test/image.png)';
		const parsed = parseDocument(source);
		const manager = new MarkdownManager({ extensions: composerMarkdownEditorExtensions() });
		const serialized = manager.serialize(parsed);
		expect(serialized).toContain('First<br>Second');
		expect(serialized).toContain('synthetic');
		expect(serialized).toContain('keep');
		expect(serialized).toContain('https://example.test/image.png');
		const escaped = parseDocument('| A | B |\n| - | - |\n| one\\|two | three |');
		expect(manager.serialize(escaped)).toContain('one\\|two');
	});
	it('preserves code spaces and avoids multiplying long cells across every row', () => {
		const source =
			'| Code | Note |\n| --- | --- |\n| `a  b` | original |\n| ' +
			'x'.repeat(10_000) +
			' | note |\n' +
			'| short | note |\n'.repeat(200);
		const document = parseDocument(source);
		const manager = new MarkdownManager({ extensions: composerMarkdownEditorExtensions() });
		const output = manager.serialize(document);
		expect(output).toContain('`a  b`');
		expect(output.length).toBeLessThan(source.length + 100);
	});
	it('preserves separate paragraphs in an edited table cell', () => {
		const document = parseDocument(table);
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
		const document = parseDocument(table);
		const cell = nodes(document).find((node) => node.type === 'tableCell')!;
		cell.content = [
			{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'code' }] }] },
		];
		const manager = editingManager();
		const output = manager.parse(serializeComposerMarkdown(manager, document));
		const paragraph = nodes(output).find((node) => node.type === 'tableCell')!.content![0];
		expect(
			paragraph.content!.map((node) => (node.type === 'hardBreak' ? '\n' : node.text)).join(''),
		).toBe(text);
	});
});

describe('composer Markdown source preservation', () => {
	const prompt =
		'<context>\nUse my_var in ~/cfg, C:\\Users\\me, a < b && c, see https://x.test/a_b\n</context>\n\n\n\n' +
		'i++ and j++ with [x] and @path/my_file.ts\n\n' +
		'| A | B |\n| - | - |\n| max_tokens | <1ms |\n\n' +
		'[`foo()`](https://x.test/docs)   trailing spaces  \n';

	it('maps every top-level node to the source that produced it', () => {
		const { document, sources } = parseComposerMarkdown({ source: prompt })!;
		expect(sources).toHaveLength(document.content!.length);
		expect(sources.join('')).toBe(prompt);
	});
	it('rewrites only the edited table and keeps the rest of the draft exact', () => {
		const output = serializeAfterEdit(prompt, (content) =>
			content.map((node) => (node.type === 'table' ? editFirstCell(node, 'top_p') : node)),
		);
		expect(output).toBe(
			prompt.replace('| - | - |\n| max_tokens |', '| --- | --- |\n| top_p |'),
		);
	});
	it('restores the exact draft when an edit is undone', () => {
		// Undo yields nodes equal to the parsed ones that are no longer the same objects.
		const undone = (content: JSONContent[]) => content.map((node) => structuredClone(node));
		const deepEquals = (a: JSONContent, b: JSONContent) => JSON.stringify(a) === JSON.stringify(b);
		expect(serializeAfterEdit(prompt, undone, deepEquals)).toBe(prompt);
		expect(serializeAfterEdit(prompt, undone)).not.toBe(prompt);
	});
	it('separates an inserted paragraph from its unedited neighbours', () => {
		const output = serializeAfterEdit('first\n| a |\n| - |\n| 1 |\n', (content) => [
			content[0],
			{ type: 'paragraph', content: [{ type: 'text', text: 'inserted' }] },
			...content.slice(1),
		]);
		expect(output).toBe('first\n\ninserted\n\n| a |\n| - |\n| 1 |\n');
	});
	it('keeps the source of a block that moved', () => {
		const output = serializeAfterEdit('one_a\n\ntwo_b\n\nthree_c', (content) => [
			content[1],
			content[0],
			content[2],
		]);
		expect(output).toBe('two_b\n\none_a\n\nthree_c');
	});
	it.each([
		['snake case, paths, and comparisons', 'my_var ~/cfg C:\\Users\\me a < b && c <tag>'],
		['a bare link', 'see https://x.test/a_b now'],
		['increments', 'i++ and j++'],
		['a link around code', '[`foo()`](https://x.test/docs)'],
		['bold code', '**`bold code`**'],
		['spaced operators', 'a * b _ c'],
		['brackets', 'see [x] and arr[0]'],
		['an escaped emphasis marker', 'not \\*emphasis\\*'],
		['an escaped entity', 'literal &amp;lt; text'],
		['an escaped link', '\\[label](https://x.test)'],
		['a soft line break', 'line one\nline two'],
	])('writes %s back as it was typed', (_name, source) => {
		const manager = editingManager();
		expect(serializeComposerMarkdown(manager, parseDocument(source))).toBe(source);
	});
	it('keeps text that would open a block escaped', () => {
		const manager = editingManager();
		const paragraph = (text: string): JSONContent => ({
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
		});
		for (const text of ['> not a quote', '* not a list', '*emphasis*', '_emphasis_', '[a](b)']) {
			const output = serializeComposerMarkdown(manager, paragraph(text));
			expect(manager.parse(output)).toEqual(paragraph(text));
		}
	});
	it.each([
		['a code block', '````md\n```\ninner\n```\n````'],
		[
			'a table and a code block in one block quote',
			'> | a |\n> | --- |\n> | 1 |\n>\n> ````\n> ```\n> x_y <b>\n> ````',
		],
	])('fences %s past every backtick run in its body', (_name, source) => {
		const manager = editingManager();
		const document = parseDocument(source);
		const output = serializeComposerMarkdown(manager, document);
		expect(output).toBe(source);
		expect(manager.parse(output)).toEqual(manager.parse(source));
	});
	it('lengthens the fence when an edit adds a longer backtick run', () => {
		const manager = editingManager();
		const document = parseDocument('```\ncode\n```');
		document.content![0].content = [{ type: 'text', text: 'before\n````\nafter' }];
		const output = serializeComposerMarkdown(manager, document);
		expect(output).toBe('`````\nbefore\n````\nafter\n`````');
		expect(manager.parse(output).content).toHaveLength(1);
	});
	it('does not write a placeholder for repeated empty paragraphs', () => {
		const manager = editingManager();
		const empty = { type: 'paragraph' };
		const text = { type: 'paragraph', content: [{ type: 'text', text: 'after' }] };
		expect(
			serializeComposerMarkdown(manager, { type: 'doc', content: [empty, empty, empty, text] }),
		).not.toContain('nbsp');
	});
	it('falls back to full escaping when the draft uses every private-use character', () => {
		const manager = editingManager();
		const privateUse = Array.from({ length: 0xf900 - 0xe000 }, (_, offset) =>
			String.fromCharCode(0xe000 + offset),
		).join('');
		const document: JSONContent = {
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: `my_var ${privateUse}` }] }],
		};
		expect(serializeComposerMarkdown(manager, document)).toBe(`my\\_var ${privateUse}`);
	});
	it('keeps text that already uses private-use characters intact', () => {
		const manager = editingManager();
		const source = 'icon \ue000\ue003 my_var';
		expect(serializeComposerMarkdown(manager, parseDocument(source))).toBe(source);
	});
	it('serializes an oversized paste into the edited block only', () => {
		const { document, sources } = parseComposerMarkdown({ source: prompt })!;
		const original = document.content!;
		const edited = original.map((node) =>
			node.type === 'table' ? editFirstCell(node, 'marker') : node,
		);
		const output = serializeComposerMarkdownPaste({
			blocks: planComposerMarkdownBlocks(original, sources, edited, (a, b) => a === b),
			originalCount: original.length,
			marker: 'marker',
			text: 'a|b\nmy_var',
		});
		expect(output).toBe(
			prompt.replace('| - | - |\n| max_tokens |', '| --- | --- |\n| a\\|b<br>my_var |'),
		);
	});
});

describe('Markdown detection', () => {
	it('screens long input in linear time', () => {
		const started = performance.now();
		isMarkdownCandidate(' '.repeat(30_000) + 'x');
		isMarkdownCandidate('1'.repeat(30_000));
		isMarkdownCandidate(('\t'.repeat(300) + 'x\n').repeat(100));
		expect(performance.now() - started).toBeLessThan(250);
	});
});

describe('Markdown table detection', () => {
	it.each([
		'| a | b |\n| --- | --- |\n| 1 | 2 |',
		'a | b\n--- | ---\n1 | 2',
		'> | a |\n> | - |',
		'- Review\n\n  | a |\n  | :-: |',
		'1. item\n   |a|\n   |-|',
	])('accepts a delimiter row: %s', (source) => {
		expect(isMarkdownTableCandidate(source)).toBe(true);
	});
	it.each(['text | more\nno delimiter', '---\n\ntext | x', 'plain notes'])(
		'rejects text without a delimiter row: %s',
		(source) => {
			expect(isMarkdownTableCandidate(source)).toBe(false);
		},
	);
	it('scans long runs of leading whitespace once', () => {
		const started = performance.now();
		expect(isMarkdownTableCandidate('\t'.repeat(3_000) + '|')).toBe(false);
		expect(isMarkdownTableCandidate(('x|\n' + ' '.repeat(300)).repeat(100))).toBe(false);
		expect(performance.now() - started).toBeLessThan(250);
	});
});
