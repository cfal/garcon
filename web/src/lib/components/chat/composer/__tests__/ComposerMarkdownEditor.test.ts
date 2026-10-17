import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TiptapEditorHTMLElement } from '@tiptap/core';
import ComposerMarkdownEditor from '../ComposerMarkdownEditor.svelte';
import { parseComposerMarkdown } from '../composer-markdown-parser.js';
import type { ComposerMarkdownMention } from '../prompt-composer-markdown-controller.js';

afterEach(cleanup);

function mount(source: string, caret?: number, { handsOverSnippets = true } = {}) {
	const parsed = parseComposerMarkdown({ source, caret })!;
	const onChange = vi.fn<(source: string) => void>();
	const onMention = vi.fn<(mention: ComposerMarkdownMention | null) => void>();
	const onSnippet = vi.fn<(text: string, caret: number) => boolean>(() => handsOverSnippets);
	const onOverflow = vi.fn<(source: string) => void>();
	const onMarkdownPaste = vi.fn<(source: string, caret: number) => void>();
	render(ComposerMarkdownEditor, {
		...parsed,
		readOnly: false,
		snippetTrigger: ';;',
		onChange,
		onMention,
		onSnippet,
		onSourceAction: vi.fn(),
		onComposerKeydown: vi.fn(),
		onCompletionKeydown: () => false,
		onReady: vi.fn(),
		onLargePaste: vi.fn(),
		onMarkdownPaste,
		onOverflow,
	});
	const editor = (screen.getByRole('textbox') as TiptapEditorHTMLElement).editor!;
	return { editor, onChange, onMention, onSnippet, onOverflow, onMarkdownPaste };
}

function type(editor: ReturnType<typeof mount>['editor'], text: string) {
	for (const character of text) {
		const { from, to } = editor.state.selection;
		const handled = editor.view.someProp('handleTextInput', (handler) =>
			handler(editor.view, from, to, character, () => editor.state.tr.insertText(character)),
		);
		if (!handled) editor.view.dispatch(editor.state.tr.insertText(character, from, to));
	}
}

function newline(editor: ReturnType<typeof mount>['editor'], shiftKey = true) {
	return editor.view.someProp('handleKeyDown', (handler) =>
		handler(editor.view, new KeyboardEvent('keydown', { key: 'Enter', shiftKey })),
	);
}

// Mirrors the browser deletion path, which preserves marks for subsequent typing.
function deleteText(editor: ReturnType<typeof mount>['editor'], from: number, to: number) {
	const marks = editor.state.doc.resolve(from).marksAcross(editor.state.doc.resolve(to));
	const transaction = editor.state.tr.delete(from, to);
	if (marks) transaction.ensureMarks(marks);
	editor.view.dispatch(transaction);
}

describe('formatted editor cleared drafts', () => {
	it.each(['`ab`', '**ab**', '_ab_', '~~ab~~', '**_ab_**', '[ab](https://example.test)'])(
		'starts unformatted after deleting the last text in %s',
		(source) => {
			const { editor, onChange } = mount(source);
			deleteText(editor, 2, 3);
			deleteText(editor, 1, 2);
			expect(editor.state.doc.toJSON()).toEqual({
				type: 'doc',
				content: [{ type: 'paragraph' }],
			});
			expect(editor.state.storedMarks ?? []).toEqual([]);
			expect(onChange).toHaveBeenLastCalledWith('');
			type(editor, 'new');
			expect(onChange).toHaveBeenLastCalledWith('new');
		},
	);
	it('clears marks from typed code after deleting its trailing space and contents', () => {
		const { editor, onChange } = mount('');
		type(editor, '`ab` ');
		for (let end = 4; end > 1; end--) deleteText(editor, end - 1, end);
		type(editor, 'new');
		expect(onChange).toHaveBeenLastCalledWith('new');
	});
	it('restores deleted formatting with Undo and clears it again with Redo', () => {
		const { editor, onChange } = mount('`ab`');
		deleteText(editor, 1, 3);
		expect(editor.commands.undo()).toBe(true);
		expect(onChange).toHaveBeenLastCalledWith('`ab`');
		expect(editor.view.dom.querySelector('code')?.textContent).toBe('ab');
		expect(editor.commands.redo()).toBe(true);
		expect(onChange).toHaveBeenLastCalledWith('');
		type(editor, 'new');
		expect(onChange).toHaveBeenLastCalledWith('new');
	});
	it('retains formatting when deletion leaves text in the draft', () => {
		const { editor, onChange } = mount('`ab`');
		deleteText(editor, 2, 3);
		type(editor, 'new');
		expect(onChange).toHaveBeenLastCalledWith('`anew`');
	});
	it.each(['> `ab`', '- `ab`', 'before\n\n`ab`'])(
		'retains formatting when only a nested or later paragraph is emptied: %s',
		(source) => {
			const { editor, onChange } = mount(source);
			const end = editor.state.selection.to;
			deleteText(editor, end - 2, end);
			type(editor, 'new');
			expect(onChange).toHaveBeenLastCalledWith(source.replace('ab', 'new'));
		},
	);
	it('preserves intentional formatting enabled in an empty draft', () => {
		const { editor, onChange } = mount('`ab`');
		deleteText(editor, 1, 3);
		editor.commands.toggleCode();
		type(editor, 'new');
		expect(onChange).toHaveBeenLastCalledWith('`new`');
	});
	it('does not mistake an image-only paragraph for a cleared draft', () => {
		const { editor } = mount('![alt](https://example.test/image.png)**ab**');
		const end = editor.state.selection.to;
		deleteText(editor, end - 2, end);
		type(editor, 'new');
		expect(editor.view.dom.querySelector('img')).not.toBeNull();
		expect(editor.view.dom.querySelector('strong')?.textContent).toBe('new');
	});
	it('keeps marks during a temporary empty IME replacement', () => {
		const { editor, onChange } = mount('`ab`');
		editor.view.dispatch(
			editor.state.tr
				.delete(1, 3)
				.ensureMarks([editor.schema.marks.code.create()])
				.setMeta('composition', 1),
		);
		type(editor, 'new');
		expect(onChange).toHaveBeenLastCalledWith('`new`');
	});
});

it('preserves source of a retained equivalent paragraph through deletion and history', () => {
	const source = 'a.b\n\na\\.b';
	const { editor, onChange } = mount(source);
	const retained = editor.state.doc.child(1);
	editor.commands.deleteRange({ from: 0, to: editor.state.doc.firstChild!.nodeSize });
	expect(editor.state.doc.firstChild).toBe(retained);
	expect(onChange).toHaveBeenLastCalledWith('a\\.b');
	expect(editor.commands.undo()).toBe(true);
	expect(onChange).toHaveBeenLastCalledWith(source);
	expect(editor.commands.redo()).toBe(true);
	expect(onChange).toHaveBeenLastCalledWith('a\\.b');
});

describe('composer newline intent', () => {
	it('shows the existing Reply placeholder only while empty', () => {
		const { editor } = mount('');
		expect(editor.view.dom.querySelector('p.is-editor-empty')?.getAttribute('data-placeholder')).toBe(
			'Reply...',
		);
		type(editor, 'message');
		expect(editor.view.dom.querySelector('p.is-editor-empty')).toBeNull();
	});
	it.each(['- ', '1. ', '- [ ] ', '> - '])('replaces only selected list text: %s', (prefix) => {
		const { editor, onChange } = mount(prefix + 'abcdefgh');
		const end = editor.state.selection.to;
		editor.commands.setTextSelection({ from: end - 6, to: end - 4 });
		expect(newline(editor)).toBe(true);
		expect(editor.state.doc.textContent).toBe('abefgh');
		expect(editor.state.selection.$from.parent.textContent).toBe('efgh');
		editor.commands.undo();
		expect(onChange).toHaveBeenLastCalledWith(prefix + 'abcdefgh');
	});
	it('creates prose beside a selected block without deleting it', () => {
		const { editor } = mount('---');
		editor.commands.setNodeSelection(0);
		expect(newline(editor)).toBe(true);
		expect(editor.state.doc.childCount).toBe(2);
		expect(editor.state.doc.child(0).type.name).toBe('horizontalRule');
		expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
	});
	it.each(['---', '*** ', '___ '])('keeps typed divider syntax literal: %s', (text) => {
		const { editor } = mount('');
		type(editor, text);
		expect(editor.state.doc.childCount).toBe(1);
		expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
		expect(editor.state.doc.textContent).toBe(text);
	});
	it.each(['', '  \n\n'])('mounts a valid editable empty draft: %j', (source) => {
		const { editor } = mount(source);
		expect(() => editor.state.doc.check()).not.toThrow();
		expect(newline(editor, false)).toBe(true);
		expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe('hardBreak');
	});
	it('hands interactive length growth back to Source without truncation', () => {
		const source = 'x'.repeat(32_760);
		const { editor, onOverflow } = mount(source);
		editor.commands.insertContent('additional text');
		expect(onOverflow).toHaveBeenLastCalledWith(source + 'additional text');
	});
	it('bounds interactive node growth even when the Markdown is short', () => {
		const { editor, onOverflow } = mount('start');
		editor.commands.setContent({
			type: 'doc',
			content: Array.from({ length: 1_001 }, () => ({
				type: 'paragraph',
				content: [{ type: 'text', text: 'item' }],
			})),
		});
		expect(onOverflow).toHaveBeenLastCalledWith(Array(1_001).fill('item').join('\n\n'));
	});
	it.each([true, false])('leaves a quote without removing it (shift=%s)', (shift) => {
		const { editor, onChange } = mount('> abc');
		newline(editor, shift);
		newline(editor, shift);
		type(editor, 'outside');
		expect(onChange).toHaveBeenLastCalledWith('> abc\n\noutside');
		expect(editor.state.doc.child(0).type.name).toBe('blockquote');
		expect(editor.state.doc.child(1).type.name).toBe('paragraph');
	});
	it.each(['- item', '1. item', '- [ ] item'])('leaves an empty list item: %s', (source) => {
		const { editor, onChange } = mount(source);
		newline(editor);
		newline(editor);
		type(editor, 'outside');
		expect(onChange).toHaveBeenLastCalledWith(`${source}\n\noutside`);
	});
	it('continues a heading as prose', () => {
		const { editor, onChange } = mount('# Title');
		newline(editor);
		type(editor, 'body');
		expect(onChange).toHaveBeenLastCalledWith('# Title\n\nbody');
	});
	it('adds code lines and exits on the third trailing newline', () => {
		const { editor, onChange } = mount('```js\nlet a\n```');
		newline(editor);
		type(editor, 'let b');
		expect(onChange).toHaveBeenLastCalledWith('```js\nlet a\nlet b\n```');
		newline(editor);
		newline(editor);
		newline(editor);
		type(editor, 'after');
		expect(onChange).toHaveBeenLastCalledWith('```js\nlet a\nlet b\n```\n\nafter');
	});
	it('preserves cell breaks inside a quote', () => {
		const source = '> | A | B |\n> | --- | --- |\n> | x | y |';
		const { editor, onChange } = mount(source);
		newline(editor);
		type(editor, 'z');
		expect(onChange).toHaveBeenLastCalledWith(source.replace('y |', 'y<br>z |'));
	});
	it('replaces selected cell text with an inline break', () => {
		const { editor, onChange } = mount('| A |\n| --- |\n| word |');
		const end = editor.state.selection.to;
		editor.commands.setTextSelection({ from: end - 4, to: end });
		newline(editor);
		type(editor, 'z');
		expect(onChange).toHaveBeenLastCalledWith('| A |\n| --- |\n| <br>z |');
	});
	it('leaves the nearest quote rather than splitting its outer list', () => {
		const { editor } = mount('- item\n\n  > inner');
		newline(editor);
		newline(editor);
		type(editor, 'after');
		expect(editor.state.doc.child(0).childCount).toBe(1);
		expect(editor.state.selection.$from.node(-1).type.name).toBe('listItem');
	});
	it('does not edit or submit composition Enter', () => {
		const { editor, onChange } = mount('> abc');
		editor.view.dom.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'Enter',
				keyCode: 229,
				isComposing: true,
				bubbles: true,
			}),
		);
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe('formatted editor clipboard contexts', () => {
	it.each([4, 10])('uses the restored inline-code marks at source caret %s', (caret) => {
		const { editor, onChange, onMarkdownPaste } = mount('Use `code` here', caret);
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', '**bold**');
		editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
		expect(onMarkdownPaste).toHaveBeenCalledOnce();
		expect(onChange).not.toHaveBeenCalled();
	});
	it('uses the code marks across a selected code span', () => {
		const { editor, onChange, onMarkdownPaste } = mount('Use `code` here');
		editor.commands.setTextSelection({ from: 5, to: 9 });
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', 'a`b');
		editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
		expect(onMarkdownPaste).not.toHaveBeenCalled();
		expect(onChange).toHaveBeenLastCalledWith('Use ``a`b`` here');
	});
	it('uses an explicitly stored code mark at the opening delimiter', () => {
		const { editor, onChange, onMarkdownPaste } = mount('Use `code` here', 5);
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', 'a`b');
		editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
		expect(onMarkdownPaste).not.toHaveBeenCalled();
		expect(onChange).toHaveBeenLastCalledWith('Use ``a`bcode`` here');
	});
	it('keeps backticks literal when pasting inside inline code', () => {
		const { editor, onChange, onMarkdownPaste } = mount('Use `code` here', 7);
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', 'a`b');
		editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
		expect(onMarkdownPaste).not.toHaveBeenCalled();
		expect(onChange).toHaveBeenLastCalledWith('Use ``coa`bde`` here');
	});
	it.each(['```\ncode\n```', '| Cell |\n| --- |\n| text |'])(
		'keeps clipboard text literal inside %s',
		(source) => {
			const { editor, onChange, onMarkdownPaste } = mount(source);
			const text = ' **literal** `code`';
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', text);
			editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
			expect(onMarkdownPaste).not.toHaveBeenCalled();
			expect(editor.state.selection.$from.parent.textContent).toContain(text);
			expect(onChange).toHaveBeenCalledOnce();
		},
	);
});

describe('formatted editor file mentions', () => {
	it('reports a mention at the caret and replaces it with the chosen path', () => {
		const { editor, onChange, onMention } = mount('Review **this** now');
		editor.chain().focus('end').insertContent('  and more').run();
		editor.commands.setTextSelection(editor.state.doc.content.size - 1 - '  and more'.length);
		editor.commands.insertContent(' @sr');
		const mention = onMention.mock.lastCall?.[0];
		expect(mention?.query).toBe('sr');

		mention!.insert('src/my_file.ts');

		expect(onChange).toHaveBeenLastCalledWith('Review **this** now @src/my_file.ts and more');
		expect(onMention).toHaveBeenLastCalledWith(null);
	});
	it('quotes a path with spaces and keeps a following line break', () => {
		const { editor, onChange, onMention } = mount('- one **item**\n- two');
		editor.commands.focus('end');
		editor.commands.insertContent(' @n');
		onMention.mock.lastCall?.[0]?.insert('my notes.md');
		expect(onChange).toHaveBeenLastCalledWith('- one **item**\n- two @"my notes.md" ');
	});
	it('does not report a mention inside code or mid-word', () => {
		const { editor, onMention } = mount('Run `x` now\n\n```\ncode\n```');
		editor.chain().focus('end').insertContent('@src').run();
		editor.commands.setTextSelection(6);
		editor.commands.insertContent('@y');
		editor.chain().focus('start').insertContent('mail@host').run();
		expect(onMention.mock.calls.every(([mention]) => mention === null)).toBe(true);
	});
});

describe('formatted editor file mentions on load', () => {
	it('does not open the menu for a restored draft that ends in a mention', () => {
		const { editor, onMention } = mount('Review **this** @src');
		editor.commands.focus('end');
		expect(onMention).not.toHaveBeenCalled();
		editor.commands.insertContent('/a');
		expect(onMention.mock.lastCall?.[0]?.query).toBe('src/a');
	});
});

describe('formatted editor snippet triggers', () => {
	it('hands over the serialized draft with the caret after a typed trigger', () => {
		const { editor, onChange, onSnippet } = mount('Use **context** here\n\n- one\n- two');
		editor.commands.setTextSelection(17);
		type(editor, ' ;;re');
		const source = 'Use **context** here ;;re\n\n- one\n- two';
		expect(onSnippet).toHaveBeenLastCalledWith(source, 'Use **context** here ;;re'.length);
		expect(onChange).not.toHaveBeenCalledWith(source);
	});
	it('keeps editing formatted when the trigger is not handed over', () => {
		const { editor, onChange, onSnippet } = mount('Use **context**', 15, {
			handsOverSnippets: false,
		});
		type(editor, ' ;;');
		expect(onSnippet).toHaveBeenCalledOnce();
		expect(onChange).toHaveBeenLastCalledWith('Use **context** ;;');
	});
	it('ignores a prefix typed mid-word', () => {
		const { editor, onSnippet } = mount('Use **context**', 15);
		type(editor, 'x;;');
		expect(onSnippet).not.toHaveBeenCalled();
	});
});

describe('formatted editor links and images', () => {
	it('keeps destinations that need angle brackets when their paragraph is edited', () => {
		const source = 'See [file](</path/with space.md> "a \\"quoted\\" title") and ![alt](<a b>)';
		const { editor, onChange } = mount(source, source.length);
		type(editor, ' now');
		const written = onChange.mock.lastCall![0];
		expect(written).toBe(`${source} now`);
		const reparsed = parseComposerMarkdown({ source: written })!.document;
		const [paragraph] = reparsed.content!;
		const link = paragraph.content!.find((node) => node.marks?.[0]?.type === 'link')!;
		expect(link.marks![0].attrs).toMatchObject({
			href: '/path/with space.md',
			title: 'a "quoted" title',
		});
		expect(paragraph.content!.find((node) => node.type === 'image')?.attrs?.src).toBe('a b');
	});
	it('wraps a destination that an edit leaves unable to stand bare', () => {
		const { editor, onChange } = mount('Read [docs](https://example.test/a) first', 41);
		const { from } = editor.state.selection;
		editor.view.dispatch(
			editor.state.tr.addMark(
				from - ' first'.length - 'docs'.length,
				from - ' first'.length,
				editor.schema.marks.link.create({ href: 'https://example.test/a (b' }),
			),
		);
		expect(onChange).toHaveBeenLastCalledWith('Read [docs](<https://example.test/a (b>) first');
	});
});

describe('formatted editor emphasis delimiters', () => {
	it('keeps written underscores when their paragraph is edited', () => {
		const { editor, onChange } = mount('edit __init__.py and _private_ names', 36);
		type(editor, ' now');
		expect(editor.view.dom.querySelector('strong')?.textContent).toBe('init');
		expect(onChange).toHaveBeenLastCalledWith('edit __init__.py and _private_ names now');
	});
	it('keeps underscores typed in the formatted editor', () => {
		const { editor, onChange } = mount('Review **this** now');
		type(editor, ' __name__ and _other_ too');
		expect(onChange).toHaveBeenLastCalledWith('Review **this** now __name__ and _other_ too');
	});
	it('writes asterisks where a letter typed beside the mark would stop underscores parsing', () => {
		const { editor, onChange } = mount('see _this_', 10);
		type(editor, 's');
		expect(onChange).toHaveBeenLastCalledWith('see *this*s');
	});
});

describe('live formatted editor typing', () => {
	it('formats explicit links while keeping bare addresses and identifiers literal', () => {
		const { editor, onChange } = mount('Review **this** now');
		type(editor, ' my_var https://example.test [guide](https://example.test)');
		expect(editor.view.dom.querySelectorAll('a')).toHaveLength(1);
		expect(editor.view.dom.querySelector('a')?.textContent).toBe('guide');
		expect(onChange).toHaveBeenLastCalledWith(
			'Review **this** now my_var https://example.test [guide](https://example.test)',
		);
	});
	it('ends a typed bold mark at its closing delimiters before accepting subsequent prose', () => {
		const { editor, onChange } = mount('Ship **two**', 12);
		type(editor, ' and **three** now');
		expect(
			Array.from(editor.view.dom.querySelectorAll('strong'), (element) => element.textContent),
		).toEqual(['two', 'three']);
		expect(onChange).toHaveBeenLastCalledWith('Ship **two** and **three** now');
	});
	it('ends a typed bold mark even when the caret marks were dropped before the first input', () => {
		const { editor, onChange } = mount('Ship **two**', 12);
		// A selection sync straight after focus discards stored marks.
		editor.view.dispatch(editor.state.tr.setStoredMarks(null));
		type(editor, ' and **three** now');
		expect(
			Array.from(editor.view.dom.querySelectorAll('strong'), (element) => element.textContent),
		).toEqual(['two', 'three']);
		expect(onChange).toHaveBeenLastCalledWith('Ship **two** and **three** now');
	});
	it('keeps typing inside a mark when the draft was converted with the caret inside it', () => {
		const { editor, onChange } = mount('Ship **two** now', 9);
		editor.view.dispatch(editor.state.tr.setStoredMarks(null));
		type(editor, 'X');
		expect(onChange).toHaveBeenLastCalledWith('Ship **twXo** now');
	});
	it('formats subsequent bold syntax and lets undo restore the typed delimiters', () => {
		const { editor, onChange } = mount('Review **this** now');
		type(editor, ' **more**');
		expect(editor.view.dom.querySelectorAll('strong')).toHaveLength(2);
		expect(onChange).toHaveBeenLastCalledWith('Review **this** now **more**');
		editor.commands.undoInputRule();
		expect(editor.state.doc.textContent).toContain('**more**');
	});
	it('converts a completed table within a rich draft and preserves surrounding bold', () => {
		const { editor, onChange } = mount('Review **this** now');
		editor.commands.insertContent({
			type: 'paragraph',
			content: [
				{ type: 'text', text: '| <tag> | Value |' },
				{ type: 'hardBreak' },
				{ type: 'text', text: '| --- | --- ' },
			],
		});
		type(editor, '|');
		expect(editor.view.dom.querySelectorAll('table')).toHaveLength(1);
		expect(editor.view.dom.querySelector('strong')?.textContent).toBe('this');
		expect(onChange.mock.lastCall?.[0]).toContain('| <tag> | Value |\n| --- | --- |');
		editor.commands.undo();
		expect(editor.view.dom.querySelectorAll('table')).toHaveLength(0);
	});
	it('continues a numbered list when Enter is accepted as a newline', () => {
		const { editor, onChange } = mount('1. first');
		editor.view.someProp('handleKeyDown', (handler) =>
			handler(editor.view, new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true })),
		);
		type(editor, 'second');
		expect(editor.view.dom.querySelectorAll('ol > li')).toHaveLength(2);
		expect(onChange).toHaveBeenLastCalledWith('1. first\n2. second');
	});
});
