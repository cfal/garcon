import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadComposerMarkdownEditor } from '../composer-markdown-editor-loader.js';
import PromptComposerTestHost from './PromptComposerTestHost.svelte';
import {
	parseComposerMarkdownInWorker,
	serializeComposerMarkdownPasteInWorker,
} from '../composer-markdown-worker.js';
import {
	parseComposerMarkdown,
	serializeComposerMarkdownPaste,
} from '../composer-markdown-parser.js';
import type { TiptapEditorHTMLElement } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { composerMarkdownEditorExtensions } from '../composer-markdown-extensions.js';
import { configureComposerMarkdown } from '../composer-markdown.js';
import * as snippetsApi from '$lib/api/snippets';
import * as commandsApi from '$lib/api/commands.js';
import * as filesApi from '$lib/api/files.js';

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
beforeAll(async () => {
	await loadComposerMarkdownEditor();
});
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
	await fireEvent.click(screen.getByRole('button', { name: 'Formatted' }));
	const editor = await screen.findByRole('textbox', { name: 'Formatted message' });
	return { ...rendered, textarea, editor, onsubmit };
}

describe('formatted composer integration', () => {
	it.each(['/', 'Review ;;', 'Review @src'])(
		'keeps the source palette open after typing %j during conversion',
		async (source) => {
			const commands = vi.spyOn(commandsApi, 'getSlashCommands').mockResolvedValue([]);
			const files = vi.spyOn(filesApi, 'getFileList').mockResolvedValue([]);
			let complete!: (value: ReturnType<typeof parseComposerMarkdown>) => void;
			const pending = new Promise<ReturnType<typeof parseComposerMarkdown>>((resolve) => {
				complete = resolve;
			});
			vi.mocked(parseComposerMarkdownInWorker).mockReturnValue(pending);
			render(PromptComposerTestHost, { selectedChatId: 'pending-palette', selectedStatus: 'draft' });
			const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
			await fireEvent.input(textarea, { target: { value: 'Review' } });
			await fireEvent.click(screen.getByRole('button', { name: 'Formatted' }));
			textarea.focus();
			await fireEvent.input(textarea, { target: { value: source } });
			const palette = await screen.findByRole('listbox');
			expect(parseComposerMarkdownInWorker).toHaveBeenCalledOnce();
			expect(vi.mocked(parseComposerMarkdownInWorker).mock.calls[0][1]?.aborted).toBe(true);
			complete(parseComposerMarkdown({ source: 'Review' }));
			await pending;
			await loadComposerMarkdownEditor();
			expect(screen.queryByRole('textbox', { name: 'Formatted message' })).toBeNull();
			expect(screen.getByRole('listbox')).toBe(palette);
			expect(textarea.value).toBe(source);
			expect(textarea.selectionStart).toBe(source.length);
			commands.mockRestore();
			files.mockRestore();
		},
	);
	it('cancels pending conversion before typing into an externally appended draft', async () => {
		let complete!: (value: ReturnType<typeof parseComposerMarkdown>) => void;
		const pending = new Promise<ReturnType<typeof parseComposerMarkdown>>((resolve) => {
			complete = resolve;
		});
		vi.mocked(parseComposerMarkdownInWorker).mockReturnValue(pending);
		render(PromptComposerTestHost, { selectedChatId: 'pending-append' });
		const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
		await fireEvent.input(textarea, { target: { value: 'Review' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Formatted' }));
		const append = screen.getByTestId('append-draft');
		append.focus();
		await fireEvent.click(append);
		expect(document.activeElement).toBe(append);
		expect(textarea.value).toBe('Review\n\nAppended review block');
		expect(vi.mocked(parseComposerMarkdownInWorker).mock.calls[0][1]?.aborted).toBe(true);
		textarea.focus();
		await fireEvent.input(textarea, { target: { value: textarea.value + '!' } });
		expect(parseComposerMarkdownInWorker).toHaveBeenCalledOnce();
		complete(parseComposerMarkdown({ source: 'Review' }));
		await pending;
		await loadComposerMarkdownEditor();
		expect(screen.queryByRole('textbox', { name: 'Formatted message' })).toBeNull();
		expect(textarea.value).toBe('Review\n\nAppended review block!');
		expect(document.activeElement).toBe(textarea);
	});
	it.each(['deleted text', 'hard break'])('resets rich history and focus delivery after clearing an empty draft with %s', async (content) => {
		const { editor, textarea, rerender } = await formatted({ source: 'old draft' });
		const previous = richEditor(editor);
		previous.commands.clearContent(true);
		if (content === 'hard break') previous.commands.setHardBreak();
		await fireEvent.click(screen.getByRole('button', { name: 'Clear draft' }));
		const current = screen.getByRole('textbox', { name: 'Formatted message' });
		expect(current).not.toBe(editor);
		expect(previous.isDestroyed).toBe(true);
		expect(richEditor(current).commands.undo()).toBe(false);
		expect(richEditor(current).getJSON()).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
		expect(textarea.value).toBe('');
		expect(document.querySelector('textarea')).toBe(textarea);
		screen.getByRole('button', { name: 'Clear draft' }).focus();
		await rerender({ focusRequestToken: 1 });
		await waitFor(() => expect(document.activeElement).toBe(current));
	});
	it.each(['button', 'request'])('cancels pending formatting through expanded-editor %s entry', async (entry) => {
		const { textarea, rerender } = await formatted();
		await fireEvent.click(screen.getByRole('button', { name: 'Source' }));
		let complete!: (value: ReturnType<typeof parseComposerMarkdown>) => void;
		vi.mocked(parseComposerMarkdownInWorker).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
		await fireEvent.click(screen.getByRole('button', { name: 'Formatted' }));
		const calls = vi.mocked(parseComposerMarkdownInWorker).mock.calls;
		const callCount = calls.length;
		const signal = calls[callCount - 1][1];
		if (entry === 'button') await fireEvent.click(screen.getByRole('button', { name: 'Open expanded composer' }));
		else await rerender({ composerEditorOpenRequestId: 1 });
		await screen.findByRole('dialog');
		expect(signal?.aborted).toBe(true);
		complete(parseComposerMarkdown({ source: table }));
		await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(screen.queryByRole('textbox', { name: 'Formatted message' })).toBeNull();
		expect(textarea.value).toBe(table);
		expect(parseComposerMarkdownInWorker).toHaveBeenCalledTimes(callCount);
	});
	it.each([false, true])('restores an empty formatted draft after clearing (admission blocked=%s)', async (blocked) => {
		const { rerender, textarea } = await formatted({ selectedStatus: 'draft' });
		if (blocked) await rerender({ directAdmissionPending: true });
		await fireEvent.click(screen.getByRole('button', { name: 'Clear draft' }));
		expect(textarea.value).toBe('');
		if (blocked) await rerender({ directAdmissionPending: false });
		await waitFor(() => expect(screen.getByRole('textbox', { name: 'Formatted message' }).textContent).toBe(''));
	});
	it('hands prompt recall from an empty formatted draft to Source without losing navigation', async () => {
		const { editor, textarea, rerender } = await formatted({ source: '' });
		await rerender({
			recallPrompts: [
				{ ordinal: 2, content: 'newest prompt' },
				{ ordinal: 1, content: 'older prompt' },
			],
		});
		await fireEvent.keyDown(editor, { key: 'ArrowUp' });
		await waitFor(() => expect(document.activeElement).toBe(textarea));
		expect(textarea.value).toBe('newest prompt');
		await fireEvent.keyDown(textarea, { key: 'ArrowUp' });
		expect(textarea.value).toBe('older prompt');
		await fireEvent.keyDown(textarea, { key: 'ArrowDown' });
		expect(textarea.value).toBe('newest prompt');
		await fireEvent.keyDown(textarea, { key: 'ArrowDown' });
		expect(textarea.value).toBe('');
	});
	it.each(['', 'ordinary prose', '> quoted\r\n\r\n'])(
		'switches modes without rewriting %j',
		async (source) => {
			const { editor, textarea } = await formatted({ source });
			expect(editor.isConnected).toBe(true);
			expect(textarea.value).toBe(source);
			await fireEvent.click(screen.getByRole('button', { name: 'Source' }));
			expect(screen.queryByRole('textbox', { name: 'Formatted message' })).toBeNull();
			expect(textarea.value).toBe(source);
		},
	);

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
		expect(onsubmit).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
		expect(onsubmit).toHaveBeenCalledOnce();
	});
	it('rewrites only the edited table and leaves the rest of the prompt as typed', async () => {
		const prompt =
			'<context>\nUse my_var in C:\\Users\\me, a < b && c\n</context>\n\n\n' +
			'| Setting | Value |\n| - | - |\n| max_tokens | <1ms |\n\n' +
			'[`run()`](https://example.test/docs)  \n';
		const { editor, textarea } = await formatted({ source: prompt });
		const rich = richEditor(editor);
		let position = 0;
		rich.state.doc.descendants((node, offset) => {
			if (node.type.name === 'text' && node.text === 'max_tokens')
				position = offset + node.nodeSize;
		});
		rich.commands.insertContentAt(position, '_limit');
		const edited = prompt.replace(
			'| - | - |\n| max_tokens |',
			'| --- | --- |\n| max_tokens_limit |',
		);
		await waitFor(() => expect(textarea.value).toBe(edited));
		rich.commands.undo();
		await waitFor(() => expect(textarea.value).toBe(prompt));
	});
	it('restores according to the explicit preference rather than Markdown detection', async () => {
		vi.mocked(parseComposerMarkdownInWorker).mockResolvedValue(
			parseComposerMarkdown({ source: table }),
		);
		render(PromptComposerTestHost, {
			selectedChatId: 'markdown-restore',
			selectedStatus: 'running',
		});
		const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
		await fireEvent.input(textarea, { target: { value: 'plain notes' } });
		await fireEvent.click(screen.getByTestId('restore-draft'));
		expect(parseComposerMarkdownInWorker).not.toHaveBeenCalled();
		await fireEvent.input(textarea, { target: { value: table } });
		await fireEvent.click(screen.getByTestId('restore-draft'));
		expect(parseComposerMarkdownInWorker).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Formatted' }));
		await screen.findByRole('textbox', { name: 'Formatted message' });
		expect(textarea.value).toBe(table);
	});
	it('leaves pasted Markdown literal until Formatted is selected', async () => {
		const source = 'Ship **two** things:\n\n1. first\n2. second';
		vi.mocked(parseComposerMarkdownInWorker).mockImplementation(async (request) =>
			parseComposerMarkdown(request),
		);
		render(PromptComposerTestHost, { selectedChatId: 'markdown-paste', selectedStatus: 'running' });
		const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
		const transfer = new DataTransfer();
		transfer.setData('text/plain', source);
		await fireEvent.paste(textarea, { clipboardData: transfer });
		await fireEvent.input(textarea, { target: { value: source }, inputType: 'insertFromPaste' });
		expect(parseComposerMarkdownInWorker).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Formatted' }));
		const editor = await screen.findByRole('textbox', { name: 'Formatted message' });
		expect(editor.querySelector('strong')?.textContent).toBe('two');
		expect(editor.querySelectorAll('ol > li')).toHaveLength(2);
		expect(textarea.value).toBe(source);
		expect(screen.getByRole('button', { name: 'Source' })).toBeTruthy();
	});
	it.each([
		['sh', false],
		['notes-markdown', true],
	])('formats literal input in mode %s only when it declares Markdown', async (model, formats) => {
		vi.mocked(parseComposerMarkdownInWorker).mockImplementation(async (request) =>
			parseComposerMarkdown(request),
		);
		const props = {
			selectedChatId: 'markdown-literal',
			executionPolicy: 'literal' as const,
			inputFormatByModel: { 'notes-markdown': 'markdown' as const },
		};
		const { rerender } = render(PromptComposerTestHost, { ...props, model });
		const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
		const source = "printf '%s\\n' _target_";
		await fireEvent.input(textarea, { target: { value: source } });
		if (formats) {
			await fireEvent.click(screen.getByRole('button', { name: 'Formatted' }));
			const editor = await screen.findByRole('textbox', { name: 'Formatted message' });
			expect(editor.querySelector('em')?.textContent).toBe('target');
			// A mode that takes its input verbatim gets the draft back exactly as typed.
			await rerender({ ...props, model: 'sh' });
			await waitFor(() =>
				expect(screen.queryByRole('textbox', { name: 'Formatted message' })).toBeNull(),
			);
		} else {
			await new Promise((done) => setTimeout(done, 300));
			expect(parseComposerMarkdownInWorker).not.toHaveBeenCalled();
			expect(screen.queryByRole('textbox', { name: 'Formatted message' })).toBeNull();
		}
		expect(textarea.value).toBe(source);
	});
	it('opens the snippet palette for a trigger typed after formatted content', async () => {
		const source = '**context** then';
		const { editor, textarea } = await formatted({ source });
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValue({
			success: true,
			source: 'snippet',
			sourceId: 'snippet-review',
			sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextExecutorId: 'local',
			contextProjectPath: '/workspace/project',
			expandedText: 'appended',
		});
		richEditor(editor).chain().focus('end').insertContent(' ;;').run();
		await waitFor(() =>
			expect(screen.queryByRole('textbox', { name: 'Formatted message' })).toBeNull(),
		);
		expect(textarea.value).toBe(source + ' ;;');
		expect(textarea.selectionStart).toBe(source.length + 3);
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		await waitFor(() => expect(textarea.value).toBe(source + ' appended'));
	});
	it('keeps Formatted mode when a draft is emptied', async () => {
		const { editor, textarea } = await formatted();
		richEditor(editor).commands.clearContent(true);
		await waitFor(() => expect(textarea.value).toBe(''));
		expect(screen.getByRole('textbox', { name: 'Formatted message' })).toBe(editor);
	});
	it('hands a draft with no formatting left to the plain editor with its commands', async () => {
		const commands = vi.spyOn(commandsApi, 'getSlashCommands').mockResolvedValue([]);
		const { editor, textarea } = await formatted({ selectedStatus: 'draft' });
		const rich = richEditor(editor);
		rich.chain().selectAll().insertContent('/in').run();
		await waitFor(() =>
			expect(screen.queryByRole('textbox', { name: 'Formatted message' })).toBeNull(),
		);
		expect(textarea.value).toBe('/in');
		await waitFor(() => expect(document.activeElement).toBe(textarea));
		expect(textarea.selectionStart).toBe(3);
		// The slash menu loads its commands once the plain editor reports the trigger.
		await waitFor(() => expect(commands).toHaveBeenCalled());
		commands.mockRestore();
	});
	it('keeps an empty undo history inside Formatted mode', async () => {
		const { editor, textarea } = await formatted();
		await fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
		expect(screen.getByRole('textbox', { name: 'Formatted message' })).toBe(editor);
		expect(textarea.value).toBe(table);
	});
	it('keeps undo inside the formatted view once the draft was edited', async () => {
		const { editor, textarea } = await formatted();
		const rich = richEditor(editor);
		rich.commands.insertContentAt(2, 'x');
		await waitFor(() => expect(textarea.value).not.toBe(table));
		rich.commands.undo();
		await fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
		expect(screen.getByRole('textbox', { name: 'Formatted message' })).toBe(editor);
		expect(textarea.value).toBe(table);
	});
	it('returns to source when another surface changes a formatted draft', async () => {
		const { textarea } = await formatted();
		await fireEvent.click(screen.getByTestId('append-draft'));
		await waitFor(() =>
			expect(screen.queryByRole('textbox', { name: 'Formatted message' })).toBeNull(),
		);
		expect(textarea.value).toBe(table + '\n\nAppended review block');
		expect(screen.queryByRole('button', { name: 'Format Markdown' })).toBeNull();
	});
	it('never submits a replayed Enter, with or without a preceding Shift key', async () => {
		const { editor, onsubmit } = await formatted();
		const rich = richEditor(editor);
		// iOS delivers the real key event to the DOM and replays it to key handlers without modifiers.
		editor.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true, bubbles: true }),
		);
		const replayed = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
		rich.view.someProp('handleKeyDown', (handler) => handler(rich.view, replayed));
		expect(onsubmit).not.toHaveBeenCalled();
		editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
		rich.view.someProp('handleKeyDown', (handler) => handler(rich.view, replayed));
		expect(onsubmit).not.toHaveBeenCalled();
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
	it('keeps an oversized paste where secure-context random identifiers are unavailable', async () => {
		const { editor, textarea } = await formatted();
		richEditor(editor).commands.setTextSelection(2);
		// Plain HTTP origins other than loopback expose `crypto` without `randomUUID`.
		const randomUUID = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
			throw new TypeError('crypto.randomUUID is not a function');
		});
		const transfer = new DataTransfer();
		transfer.setData('text/plain', 'synthetic log\n'.repeat(3_000));
		await fireEvent.paste(editor, { clipboardData: transfer });
		await waitFor(() => expect(textarea.value).toContain('synthetic log'));
		expect(randomUUID).not.toHaveBeenCalled();
		randomUUID.mockRestore();
	});
	it('moves an oversized paste into source when its serialization fails', async () => {
		vi.mocked(serializeComposerMarkdownPasteInWorker).mockResolvedValueOnce(null);
		const { editor, textarea } = await formatted();
		const text = 'synthetic log\n'.repeat(3_000);
		const transfer = new DataTransfer();
		transfer.setData('text/plain', text);
		await fireEvent.paste(editor, { clipboardData: transfer });
		await waitFor(() => expect(textarea.value).toBe(table + '\n\n' + text));
		expect(screen.queryByRole('textbox', { name: 'Formatted message' })).toBeNull();
		expect(screen.getByTestId('notification').textContent).toContain(
			'cannot use formatted editing',
		);
	});
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
			expect(textarea.value).toContain('$& synthetic log');
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
	it('waits for oversized paste before allowing keyboard or button submission', async () => {
		let resolve!: (source: string) => void;
		vi.mocked(serializeComposerMarkdownPasteInWorker).mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const { editor, textarea, onsubmit } = await formatted();
		const transfer = new DataTransfer();
		transfer.setData('text/plain', 'large clipboard '.repeat(3_000));
		await fireEvent.paste(editor, { clipboardData: transfer });
		await fireEvent.keyDown(editor, { key: 'Enter' });
		await fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
		const send = screen.getByRole('button', { name: 'Pasting text...' });
		expect(send.hasAttribute('disabled')).toBe(true);
		expect(screen.getByText('Pasting text...').getAttribute('aria-live')).toBe('polite');
		await fireEvent.click(send);
		expect(onsubmit).not.toHaveBeenCalled();
		resolve('completed paste');
		await waitFor(() => expect(textarea.value).toBe('completed paste'));
		await fireEvent.keyDown(textarea, { key: 'Enter' });
		expect(onsubmit).toHaveBeenCalledOnce();
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
		expect(editor.querySelector('img[src]')).toBeNull();
		expect(editor.textContent).toContain('Synthetic alt');
		const link = editor.querySelector('a')!;
		const event = new MouseEvent('click', { bubbles: true, cancelable: true });
		link.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
	});
});
