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
	render(ComposerMarkdownEditor, {
		...parsed,
		readOnly: false,
		snippetTrigger: ';;',
		onChange,
		onMention,
		onSnippet,
		onPlain: vi.fn(),
		onEditSource: vi.fn(),
		onSubmitKeydown: vi.fn(),
		onCompletionKeydown: () => false,
		onReady: vi.fn(),
		onLargePaste: vi.fn(),
	});
	const editor = (screen.getByRole('textbox') as TiptapEditorHTMLElement).editor!;
	return { editor, onChange, onMention, onSnippet };
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
		expect(onChange).toHaveBeenLastCalledWith('Review **this** now my_var https://example.test [guide](https://example.test)');
	});
	it('ends a typed bold mark at its closing delimiters before accepting subsequent prose', () => {
		const { editor, onChange } = mount('Ship **two**', 12);
		type(editor, ' and **three** now');
		expect(Array.from(editor.view.dom.querySelectorAll('strong'), (element) => element.textContent)).toEqual(['two', 'three']);
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
