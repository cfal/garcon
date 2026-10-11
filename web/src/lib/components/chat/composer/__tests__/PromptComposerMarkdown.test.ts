import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PromptComposerTestHost from './PromptComposerTestHost.svelte';
import { parseComposerMarkdownInWorker } from '../composer-markdown-worker.js';
import {
	parseComposerMarkdown,
	serializeComposerMarkdownPaste,
} from '../composer-markdown-parser.js';
import type { TiptapEditorHTMLElement } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { composerMarkdownEditorExtensions } from '../composer-markdown-extensions.js';
import { configureComposerMarkdown } from '../composer-markdown.js';
import * as snippetsApi from '$lib/api/snippets';

vi.mock('../composer-markdown-worker.js', () => ({
	parseComposerMarkdownInWorker: vi.fn(),
	serializeComposerMarkdownPasteInWorker: vi.fn(async (request) =>
		serializeComposerMarkdownPaste(request),
	),
}));
vi.mock('$lib/api/snippets', async (importOriginal) => {
	const actual = await importOriginal<typeof snippetsApi>();
	return { ...actual, expandSnippet: vi.fn() };
});
const table = '| Check | Example |\n| --- | --- |\n| **Ready** | `a  b` |';
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function richEditor(target: HTMLElement) {
	const editor = (target as TiptapEditorHTMLElement).editor;
	if (!editor) throw new Error('Formatted editor is not mounted');
	return editor;
}

async function formatted({
	selectedStatus = 'running',
	source = table,
}: { selectedStatus?: 'running' | 'draft'; source?: string } = {}) {
	vi.mocked(parseComposerMarkdownInWorker).mockResolvedValue(parseComposerMarkdown({ source }));
	const onsubmit = vi.fn();
	const rendered = render(PromptComposerTestHost, {
		selectedChatId: 'markdown-test',
		selectedStatus,
		snippetTemplate: ' appended',
		onsubmit,
	});
	const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
	await fireEvent.input(textarea, { target: { value: source } });
	await fireEvent.click(await screen.findByRole('button', { name: 'Format Markdown' }));
	const editor = await screen.findByRole('textbox', { name: 'Formatted message' });
	return { ...rendered, textarea, editor, onsubmit };
}

describe('formatted composer integration', () => {
	it('honors explicit shell focus requests without losing the Markdown draft', async () => {
		const { rerender, textarea, editor } = await formatted();
		await rerender({ selectedChatId: 'markdown-test', focusRequestToken: 1 });
		await waitFor(() => expect(document.activeElement).toBe(editor));
		expect(screen.getByRole('textbox', { name: 'Formatted message' })).toBe(editor);
		expect(textarea.value).toBe(table);
	});
	it('updates Markdown on a direct edit and submits that draft through the existing gate', async () => {
		const { editor, textarea, onsubmit } = await formatted();
		richEditor(editor).commands.setTextSelection(2);
		const transfer = new DataTransfer();
		transfer.setData('text/plain', 'edited ');
		await fireEvent.paste(editor, { clipboardData: transfer });
		await waitFor(() => expect(textarea.value).toContain('edited'));
		expect(textarea.value).toContain('`a  b`');
		await fireEvent.keyDown(editor, { key: 'Enter' });
		expect(onsubmit).toHaveBeenCalledOnce();
	});
	it('opens the expanded source editor with the exact original draft', async () => {
		const { textarea } = await formatted();
		await fireEvent.click(screen.getByRole('button', { name: 'Open expanded composer' }));
		await screen.findByRole('dialog');
		expect(screen.queryByRole('textbox', { name: 'Formatted message' })).toBeNull();
		expect(textarea.value).toBe(table);
	});
	it('opens pasted content at the end and restores source before snippet insertion', async () => {
		const source = 'Prefix\n\n' + table;
		const { editor, textarea } = await formatted({ source });
		const rich = richEditor(editor);
		expect(rich.state.selection.$head.parent.textContent).toBe('a  b');
		expect(rich.state.selection.$head.parentOffset).toBe(4);
		rich.commands.setTextSelection(2);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValue({
			success: true,
			source: 'snippet',
			sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: ' appended',
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		expect(screen.queryByRole('textbox', { name: 'Formatted message' })).toBeNull();
		expect(textarea.selectionStart).toBe(source.length);
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		await waitFor(() => expect(textarea.value).toBe(source + ' appended'));
	});
	it.each(['Ready', 'a  b'])(
		'escapes oversized text in table cell %s before falling back to source',
		async (original) => {
			const { editor, textarea } = await formatted();
			const rich = richEditor(editor);
			let position = 0;
			rich.state.doc.descendants((node, offset) => {
				if (node.type.name === 'text' && node.text === original) position = offset + node.nodeSize;
			});
			rich.commands.setTextSelection(position);
			const text = ' | literal `tick`\n'.repeat(2_000);
			const transfer = new DataTransfer();
			transfer.setData('text/plain', text);
			await fireEvent.paste(editor, { clipboardData: transfer });
			await waitFor(() =>
				expect(screen.queryByRole('textbox', { name: 'Formatted message' })).toBeNull(),
			);
			const manager = new MarkdownManager({
				extensions: composerMarkdownEditorExtensions(),
				markedOptions: { breaks: true },
			});
			configureComposerMarkdown(manager);
			const document = manager.parse(textarea.value);
			const rows = document.content![0].content!;
			expect(rows).toHaveLength(2);
			expect(rows.map((row) => row.content!.length)).toEqual([2, 2]);
			expect(
				rows[1]
					.content![original === 'Ready' ? 0 : 1].content![0].content!.map((node) =>
						node.type === 'hardBreak' ? '\n' : node.text,
					)
					.join(''),
			).toBe(original + text);
		},
	);
	it.each(['paste', 'drop'])(
		'keeps oversized %s text in source before HTML parsing',
		async (type) => {
			const { editor, textarea } = await formatted();
			richEditor(editor).commands.setTextSelection(2);
			const text = '$& synthetic log\n'.repeat(3_000);
			const transfer = new DataTransfer();
			transfer.setData('text/plain', text);
			transfer.setData('text/html', '<p>large</p>'.repeat(100_000));
			const reads = vi.spyOn(transfer, 'getData');
			if (type === 'paste') await fireEvent.paste(editor, { clipboardData: transfer });
			else await fireEvent.drop(editor, { dataTransfer: transfer, clientX: 0, clientY: 0 });
			await waitFor(() => expect(textarea.value).toContain('synthetic log'));
			expect(textarea.value).toContain('$&amp; synthetic log');
			expect(reads).not.toHaveBeenCalledWith('text/html');
			expect(screen.queryByRole('textbox', { name: 'Formatted message' })).toBeNull();
			await waitFor(() => expect(document.activeElement).toBe(textarea));
		},
	);
	it('blocks readonly rich edits and keyboard submission during admission', async () => {
		const { editor, textarea, rerender, onsubmit } = await formatted({ selectedStatus: 'draft' });
		await rerender({
			selectedChatId: 'markdown-test',
			selectedStatus: 'draft',
			directAdmissionPending: true,
			onsubmit,
		});
		await waitFor(() => expect(editor.getAttribute('contenteditable')).toBe('false'));
		const transfer = new DataTransfer();
		transfer.setData('text/plain', 'blocked');
		await fireEvent.paste(editor, { clipboardData: transfer });
		await fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
		expect(textarea.value).toBe(table);
		expect(onsubmit).not.toHaveBeenCalled();
	});
	it.each(['paste', 'drop'])(
		'routes image %s to attachments while retaining the rich draft',
		async (type) => {
			const { editor, textarea } = await formatted();
			const transfer = new DataTransfer();
			transfer.items.add(new File(['synthetic'], 'image.png', { type: 'image/png' }));
			if (type === 'paste') await fireEvent.paste(editor, { clipboardData: transfer });
			else await fireEvent.drop(editor, { dataTransfer: transfer });
			await waitFor(() =>
				expect(screen.getByTestId('composer-attachment-count').textContent).toBe('1'),
			);
			expect(textarea.value).toBe(table);
			expect(screen.getByRole('textbox', { name: 'Formatted message' })).toBe(editor);
		},
	);
	it('renders image references as text and prevents link navigation', async () => {
		const { editor } = await formatted({
			source:
				table +
				'\n\n![Synthetic alt](https://example.test/image.png)\n\n[Link](https://example.test)',
		});
		expect(editor.querySelector('img')).toBeNull();
		expect(editor.textContent).toContain('Synthetic alt');
		const link = editor.querySelector('a')!;
		const event = new MouseEvent('click', { bubbles: true, cancelable: true });
		link.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
	});
});
