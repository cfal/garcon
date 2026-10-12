import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TiptapEditorHTMLElement } from '@tiptap/core';
import ComposerMarkdownEditor from '../ComposerMarkdownEditor.svelte';
import { parseComposerMarkdown } from '../composer-markdown-parser.js';
import type { ComposerMarkdownMention } from '../prompt-composer-markdown-controller.js';

afterEach(cleanup);

function mount(source: string) {
	const parsed = parseComposerMarkdown({ source })!;
	const onChange = vi.fn<(source: string) => void>();
	const onMention = vi.fn<(mention: ComposerMarkdownMention | null) => void>();
	render(ComposerMarkdownEditor, {
		...parsed,
		readOnly: false,
		onChange,
		onMention,
		onPlain: vi.fn(),
		onEditSource: vi.fn(),
		onSubmitKeydown: vi.fn(),
		onCompletionKeydown: () => false,
		onReady: vi.fn(),
		onLargePaste: vi.fn(),
	});
	const editor = (screen.getByRole('textbox') as TiptapEditorHTMLElement).editor!;
	return { editor, onChange, onMention };
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
