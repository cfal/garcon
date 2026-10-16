import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadComposerMarkdownEditor } from '../composer-markdown-editor-loader.js';
import { PromptComposerMarkdownController } from '../prompt-composer-markdown-controller.js';
import { PromptComposerUiState } from '../prompt-composer-state.svelte.js';
import {
	parseComposerMarkdownInWorker,
	serializeComposerMarkdownPasteInWorker,
} from '../composer-markdown-worker.js';
import type {
	ComposerMarkdownDocument,
	ComposerMarkdownPasteRequest,
} from '../composer-markdown-parser.js';

vi.mock('../composer-markdown-editor-loader.js', () => ({
	loadComposerMarkdownEditor: vi.fn(
		async () => (await import('../ComposerMarkdownEditor.svelte')).default,
	),
}));
vi.mock('../composer-markdown-worker.js', () => ({
	parseComposerMarkdownInWorker: vi.fn(),
	serializeComposerMarkdownPasteInWorker: vi.fn(),
}));
beforeAll(async () => {
	await loadComposerMarkdownEditor();
});
const table = '| A | B |\n| - | - |\n| first | second |';
const parsed: ComposerMarkdownDocument = {
	document: { type: 'doc', content: [{ type: 'paragraph' }] },
	sources: [null],
};
const pasteRequest: ComposerMarkdownPasteRequest = {
	blocks: [],
	originalCount: 0,
	marker: 'marker',
	text: 'large',
};
function fixture() {
	const ui = new PromptComposerUiState();
	const textarea = document.createElement('textarea');
	document.body.append(textarea);
	textarea.focus();
	const composer = { inputText: table, draftRestoreRequest: { chatId: 'one', requestId: 1 } };
	const options = {
		ui,
		composer,
		textarea,
		chatId: 'one',
		canFormat: true,
		get sourcePaletteOpen() {
			return ui.showSlashMenu || ui.showFileMenu || ui.snippetPalette.isOpen;
		},
		acceptsMarkdown: true,
		preferredMode: 'formatted' as 'source' | 'formatted',
		interactionGeneration: 0,
		snippetTrigger: ';;',
		onChange: vi.fn((text: string) => {
			composer.inputText = text;
		}),
		onSourceCaret: vi.fn(),
		onUnavailable: vi.fn(),
	};
	const controller = new PromptComposerMarkdownController(options);
	function paste(text: string) {
		composer.inputText = text;
		textarea.value = text;
		controller.input(new InputEvent('input', { inputType: 'insertFromPaste' }));
	}
	return { ui, options, controller, paste };
}
afterEach(() => {
	document.body.replaceChildren();
	vi.resetAllMocks();
});

describe('formatted composer input format', () => {
	it('allows explicit formatting while a source range is selected', async () => {
		const { controller, ui, options } = fixture();
		options.textarea.value = table;
		options.textarea.setSelectionRange(0, 4);
		vi.mocked(parseComposerMarkdownInWorker).mockResolvedValue(parsed);
		controller.selectMode('formatted');
		await vi.waitFor(() => expect(ui.formattedDraft?.source).toBe(table));
		controller.destroy();
	});
	it('replaces pending conversion when submission starts a fresh draft', async () => {
		const { controller, ui, options } = fixture();
		let complete!: (value: ComposerMarkdownDocument) => void;
		vi.mocked(parseComposerMarkdownInWorker)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					complete = resolve;
				}),
			)
			.mockResolvedValueOnce(parsed);
		controller.restore();
		const signal = vi.mocked(parseComposerMarkdownInWorker).mock.calls[0][1];
		options.composer.inputText = '';
		options.textarea.value = '';
		options.composer.draftRestoreRequest = { chatId: 'one', requestId: 2 };
		controller.restore();
		expect(signal?.aborted).toBe(true);
		await vi.waitFor(() => expect(ui.formattedDraft?.source).toBe(''));
		complete(parsed);
		await Promise.resolve();
		expect(ui.formattedDraft?.source).toBe('');
		controller.destroy();
	});
	it('leaves typed, pasted, and restored Markdown as source where Markdown is not accepted', async () => {
		const { controller, ui, options, paste } = fixture();
		options.acceptsMarkdown = false;
		options.textarea.value = table;
		controller.input(new InputEvent('input', { inputType: 'insertText' }));
		await new Promise((done) => setTimeout(done, 180));
		paste(table);
		controller.restore();
		await Promise.resolve();
		expect(parseComposerMarkdownInWorker).not.toHaveBeenCalled();
		expect(ui.formattedDraft).toBeNull();
		controller.destroy();
	});
	it('abandons a conversion when the model stops accepting Markdown meanwhile', async () => {
		let resolve!: (document: ComposerMarkdownDocument | null) => void;
		vi.mocked(parseComposerMarkdownInWorker).mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const { controller, ui, options } = fixture();
		controller.restore();
		await vi.waitFor(() => expect(parseComposerMarkdownInWorker).toHaveBeenCalledOnce());
		options.acceptsMarkdown = false;
		resolve(parsed);
		await Promise.resolve();
		await Promise.resolve();
		expect(ui.formattedDraft).toBeNull();
		controller.destroy();
	});
});

describe('formatted composer snippet triggers', () => {
	it('returns a typed trigger to the plain editor at its caret, where the palette opens', async () => {
		const { controller, ui, options } = fixture();
		ui.formattedDraft = { source: table, ...parsed };
		const text = '**context** ;;re';
		expect(controller.snippet(text, text.length)).toBe(true);
		expect(options.onChange).toHaveBeenCalledExactlyOnceWith(text);
		options.textarea.value = text;
		await vi.waitFor(() =>
			expect(options.onSourceCaret).toHaveBeenCalledExactlyOnceWith(text, text.length),
		);
		expect(ui.formattedDraft).toBeNull();
		expect(document.activeElement).toBe(options.textarea);
		controller.destroy();
	});
	it('leaves a dismissed trigger and plain prose in the formatted editor', () => {
		const { controller, ui, options } = fixture();
		ui.formattedDraft = { source: table, ...parsed };
		const text = '**context** ;;re';
		ui.snippetPalette.updateDetectedTrigger({ start: 12, end: 14, query: '' }, '**context** ;;');
		ui.snippetPalette.dismiss();
		expect(controller.snippet(text, text.length)).toBe(false);
		expect(controller.snippet('**context** more', 16)).toBe(false);
		expect(options.onChange).not.toHaveBeenCalled();
		expect(ui.formattedDraft).not.toBeNull();
		controller.destroy();
	});
	it('hands over a trigger typed again where a dismissed one was deleted', () => {
		const { controller, ui } = fixture();
		ui.formattedDraft = { source: table, ...parsed };
		ui.snippetPalette.updateDetectedTrigger({ start: 12, end: 14, query: '' }, '**context** ;;');
		ui.snippetPalette.dismiss();
		controller.change('**context** ');
		expect(controller.snippet('**context** ;;', 14)).toBe(true);
		controller.destroy();
	});
});

describe('formatted composer lifecycle', () => {
	describe.each(['explicit', 'restore'])('pending %s conversion', (intent) => {
		it.each(['/', 'Review ;;', 'Review @src'])(
			'cancels conversion and intent for the source palette in %j',
			async (source) => {
				const { controller, options, ui } = fixture();
				let complete!: (value: ComposerMarkdownDocument) => void;
				const pending = new Promise<ComposerMarkdownDocument>((resolve) => {
					complete = resolve;
				});
				vi.mocked(parseComposerMarkdownInWorker).mockReturnValue(pending);
				if (intent === 'explicit') controller.selectMode('formatted');
				else controller.restore();
				const signal = vi.mocked(parseComposerMarkdownInWorker).mock.calls[0][1];
				options.composer.inputText = source;
				options.textarea.value = source;
				options.textarea.setSelectionRange(source.length, source.length);
				ui.updateTriggers(source, source.length, ';;', false, 'conversation');
				const menus = [ui.showSlashMenu, ui.showFileMenu, ui.snippetPalette.isOpen];
				expect(menus.filter(Boolean)).toHaveLength(1);
				controller.input(new InputEvent('input'));
				expect(signal?.aborted).toBe(true);
				expect(parseComposerMarkdownInWorker).toHaveBeenCalledOnce();
				complete(parsed);
				await pending;
				await loadComposerMarkdownEditor();
				expect(ui.formattedDraft).toBeNull();
				expect([ui.showSlashMenu, ui.showFileMenu, ui.snippetPalette.isOpen]).toEqual(menus);
				expect(options.textarea.selectionStart).toBe(source.length);
				expect(options.preferredMode).toBe('formatted');
				ui.closeSlashMenu();
				ui.closeFileMenu();
				ui.snippetPalette.dismiss();
				controller.input(new InputEvent('input'));
				expect(parseComposerMarkdownInWorker).toHaveBeenCalledOnce();
				controller.destroy();
			},
		);
	});
	it.each(['explicit', 'restore'])('follows the source caret and focus during a pending %s', async (intent) => {
		const { controller, options, ui } = fixture();
		options.textarea.value = table;
		options.textarea.setSelectionRange(1, 1);
		let complete!: (value: ComposerMarkdownDocument) => void;
		vi.mocked(parseComposerMarkdownInWorker)
			.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }))
			.mockResolvedValueOnce(parsed);
		if (intent === 'explicit') controller.selectMode('formatted');
		else controller.restore();
		options.textarea.setSelectionRange(4, 4);
		options.interactionGeneration++;
		complete(parsed);
		await vi.waitFor(() => expect(ui.formattedDraft?.source).toBe(table));
		expect(parseComposerMarkdownInWorker).toHaveBeenLastCalledWith(
			{ source: table, caret: 4 }, expect.any(AbortSignal),
		);
		const target = document.createElement('div');
		target.tabIndex = 0;
		document.body.append(target);
		controller.focus(target);
		expect(document.activeElement).toBe(target);
		controller.destroy();
	});
	it('transfers focus after a non-editing key while source remains focused', async () => {
		const { controller, options, ui } = fixture();
		let complete!: (value: ComposerMarkdownDocument) => void;
		vi.mocked(parseComposerMarkdownInWorker).mockReturnValue(new Promise((resolve) => {
			complete = resolve;
		}));
		controller.selectMode('formatted');
		options.interactionGeneration++;
		complete(parsed);
		await vi.waitFor(() => expect(ui.formattedDraft).not.toBeNull());
		const target = document.createElement('div');
		target.tabIndex = 0;
		document.body.append(target);
		controller.focus(target);
		expect(document.activeElement).toBe(target);
		controller.destroy();
	});
	it('cancels pending conversion and intent when opening snippets', async () => {
		const { controller, options, ui } = fixture();
		options.textarea.value = table;
		options.textarea.setSelectionRange(2, 5);
		let complete!: (value: ComposerMarkdownDocument) => void;
		vi.mocked(parseComposerMarkdownInWorker).mockReturnValue(new Promise((resolve) => {
			complete = resolve;
		}));
		controller.restore();
		const signal = vi.mocked(parseComposerMarkdownInWorker).mock.calls[0][1];
		await controller.openSnippets();
		expect(signal?.aborted).toBe(true);
		complete(parsed);
		await Promise.resolve();
		await Promise.resolve();
		controller.restore();
		expect(ui.formattedDraft).toBeNull();
		expect(ui.snippetPalette.isOpen).toBe(true);
		expect(options.textarea.selectionStart).toBe(2);
		expect(options.textarea.selectionEnd).toBe(5);
		expect(parseComposerMarkdownInWorker).toHaveBeenCalledOnce();
		controller.destroy();
	});
	it('forgets conversion intent after an external source replacement', async () => {
		const { controller, options, ui } = fixture();
		let complete!: (value: ComposerMarkdownDocument) => void;
		vi.mocked(parseComposerMarkdownInWorker).mockReturnValue(new Promise((resolve) => {
			complete = resolve;
		}));
		controller.restore();
		options.composer.inputText = 'external replacement';
		complete(parsed);
		await vi.waitFor(() => expect(ui.formatPending).toBe(false));
		controller.restore();
		controller.input(new InputEvent('input'));
		expect(ui.formattedDraft).toBeNull();
		expect(parseComposerMarkdownInWorker).toHaveBeenCalledOnce();
		controller.destroy();
	});
	it('retries a blocked restore, but does not override a later source handoff', async () => {
		const { controller, options, ui } = fixture();
		vi.mocked(parseComposerMarkdownInWorker).mockResolvedValue(parsed);
		options.canFormat = false;
		controller.restore();
		expect(parseComposerMarkdownInWorker).not.toHaveBeenCalled();
		options.canFormat = true;
		controller.restore();
		await vi.waitFor(() => expect(ui.formattedDraft?.source).toBe(table));
		await controller.edit();
		controller.restore();
		expect(ui.formattedDraft).toBeNull();
		expect(parseComposerMarkdownInWorker).toHaveBeenCalledOnce();
		controller.destroy();
	});
	it('keeps a requested mode through typing while its conversion is pending', async () => {
		const { controller, options, ui } = fixture();
		let complete!: (value: ComposerMarkdownDocument) => void;
		vi.mocked(parseComposerMarkdownInWorker)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					complete = resolve;
				}),
			)
			.mockResolvedValueOnce(parsed);
		controller.selectMode('formatted');
		const signal = vi.mocked(parseComposerMarkdownInWorker).mock.calls[0][1];
		options.composer.inputText = 'new text';
		options.textarea.value = 'new text';
		controller.input(new InputEvent('input'));
		expect(signal?.aborted).toBe(true);
		await vi.waitFor(() => expect(ui.formattedDraft?.source).toBe('new text'));
		complete(parsed);
		await Promise.resolve();
		expect(ui.formattedDraft?.source).toBe('new text');
		controller.destroy();
	});
	it('applies a requested mode after unrelated interaction without moving focus', async () => {
		const { controller, options, ui } = fixture();
		let complete!: (value: ComposerMarkdownDocument) => void;
		vi.mocked(parseComposerMarkdownInWorker).mockReturnValue(
			new Promise((resolve) => {
				complete = resolve;
			}),
		);
		controller.selectMode('formatted');
		options.interactionGeneration++;
		const button = document.createElement('button');
		document.body.append(button);
		button.focus();
		complete(parsed);
		await vi.waitFor(() => expect(ui.formattedDraft?.source).toBe(table));
		const target = document.createElement('div');
		target.tabIndex = 0;
		document.body.append(target);
		controller.focus(target);
		expect(document.activeElement).toBe(button);
		controller.destroy();
	});
	it('restores an empty draft synchronously once the editor is loaded', async () => {
		const { controller, options, ui } = fixture();
		vi.mocked(parseComposerMarkdownInWorker).mockResolvedValue(parsed);
		controller.restore();
		await vi.waitFor(() => expect(ui.formattedDraft).not.toBeNull());
		options.composer.inputText = '';
		options.composer.draftRestoreRequest = { chatId: 'one', requestId: 2 };
		controller.restore();
		expect(ui.formattedDraft?.source).toBe('');
		expect(ui.formattedDraft?.document.content).toEqual([{ type: 'paragraph' }]);
		expect(parseComposerMarkdownInWorker).toHaveBeenCalledOnce();
		controller.destroy();
	});
	it.each([false, true])(
		'restores a rejected draft after an empty conversion (completed=%s)',
		async (completed) => {
			const { controller, options, ui } = fixture();
			vi.mocked(parseComposerMarkdownInWorker).mockResolvedValue(parsed);
			options.composer.inputText = '';
			controller.restore();
			if (completed) await vi.waitFor(() => expect(ui.formattedDraft?.source).toBe(''));
			options.composer.inputText = table;
			options.composer.draftRestoreRequest = { chatId: 'one', requestId: 2 };
			controller.restore();
			await vi.waitFor(() => expect(ui.formattedDraft?.source).toBe(table));
			controller.destroy();
		},
	);
	it('notifies only explicit formatting requests about unsupported content', async () => {
		const { controller, options } = fixture();
		options.composer.inputText = 'x'.repeat(40_000);
		controller.restore();
		controller.restore();
		expect(options.onUnavailable).not.toHaveBeenCalled();
		controller.selectMode('formatted');
		expect(options.onUnavailable).toHaveBeenCalledOnce();
		controller.destroy();
	});
	it('formats only on explicit selection, without changing its source', async () => {
		vi.mocked(parseComposerMarkdownInWorker).mockResolvedValue(parsed);
		const { controller, ui, options } = fixture();
		options.composer.inputText = '**bold**';
		options.textarea.value = '**bold**';
		options.textarea.setSelectionRange(8, 8);
		controller.input(new InputEvent('input', { inputType: 'insertText' }));
		await new Promise((done) => setTimeout(done, 180));
		expect(parseComposerMarkdownInWorker).not.toHaveBeenCalled();
		controller.selectMode('formatted');
		await vi.waitFor(() => expect(ui.formattedDraft?.source).toBe('**bold**'));
		expect(parseComposerMarkdownInWorker).toHaveBeenCalledExactlyOnceWith(
			{ source: '**bold**', caret: 8 },
			expect.any(AbortSignal),
		);
		expect(options.onChange).not.toHaveBeenCalled();
		controller.destroy();
	});
	it('defers composition and reparses at the new caret without dropping the mode request', async () => {
		let resolve!: (document: ComposerMarkdownDocument | null) => void;
		vi.mocked(parseComposerMarkdownInWorker).mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const { controller, ui, options } = fixture();
		controller.input(new InputEvent('input', { isComposing: true }));
		await new Promise((done) => setTimeout(done, 180));
		expect(parseComposerMarkdownInWorker).not.toHaveBeenCalled();
		options.textarea.value = table;
		options.textarea.setSelectionRange(table.length, table.length);
		controller.input(new InputEvent('input'));
		controller.selectMode('formatted');
		await vi.waitFor(() => expect(parseComposerMarkdownInWorker).toHaveBeenCalledOnce());
		options.textarea.setSelectionRange(1, 1);
		vi.mocked(parseComposerMarkdownInWorker).mockResolvedValue(parsed);
		resolve(parsed);
		await vi.waitFor(() => expect(ui.formattedDraft?.source).toBe(table));
		expect(parseComposerMarkdownInWorker).toHaveBeenLastCalledWith(
			{ source: table, caret: 1 },
			expect.any(AbortSignal),
		);
		controller.destroy();
	});
	it('applies oversized paste after releasing the shared submission gate', async () => {
		let resolve!: (text: string) => void;
		vi.mocked(serializeComposerMarkdownPasteInWorker).mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const { ui, options, controller } = fixture();
		Object.defineProperty(options, 'canFormat', { get: () => !ui.formattedPastePending });
		ui.formattedDraft = { source: table, ...parsed };
		const completion = controller.pasteSource(pasteRequest);
		expect(ui.formattedPastePending).toBe(true);
		resolve('completed paste');
		await completion;
		expect(ui.formattedPastePending).toBe(false);
		expect(options.composer.inputText).toBe('completed paste');
		expect(ui.formattedDraft).toBeNull();
		controller.destroy();
	});
	it.each(['null', 'error'])(
		'keeps the pasted text in source and unlocks submission on Worker %s',
		async (failure) => {
			if (failure === 'null')
				vi.mocked(serializeComposerMarkdownPasteInWorker).mockResolvedValue(null);
			else
				vi.mocked(serializeComposerMarkdownPasteInWorker).mockRejectedValue(
					new Error('Worker failed'),
				);
			const { ui, options, controller } = fixture();
			ui.formattedDraft = { source: table, ...parsed };
			await controller.pasteSource(pasteRequest);
			expect(ui.formattedPastePending).toBe(false);
			expect(options.composer.inputText).toBe(table + '\n\nlarge');
			expect(options.onUnavailable).toHaveBeenCalledOnce();
			expect(ui.formattedDraft).toBeNull();
			controller.destroy();
		},
	);
	it('does not unlock a newer paste when an aborted Worker completes', async () => {
		let resolve!: (text: string) => void;
		vi.mocked(serializeComposerMarkdownPasteInWorker)
			.mockReturnValueOnce(
				new Promise((done) => {
					resolve = done;
				}),
			)
			.mockReturnValueOnce(new Promise(() => {}));
		const { ui, controller } = fixture();
		ui.formattedDraft = { source: table, ...parsed };
		const request = pasteRequest;
		const completion = controller.pasteSource(request);
		controller.reset();
		ui.formattedDraft = { source: table, ...parsed };
		void controller.pasteSource(request);
		resolve('stale paste');
		await completion;
		expect(ui.formattedPastePending).toBe(true);
		controller.destroy();
		expect(ui.formattedPastePending).toBe(false);
	});
	it.each(['chat', 'edit', 'reset', 'destroy'])(
		'ignores oversized paste completion after %s',
		async (change) => {
			let resolve!: (text: string | null) => void;
			vi.mocked(serializeComposerMarkdownPasteInWorker).mockReturnValue(
				new Promise((done) => {
					resolve = done;
				}),
			);
			const { ui, options, controller } = fixture();
			ui.formattedDraft = { source: table, ...parsed };
			const completion = controller.pasteSource(pasteRequest);
			if (change === 'chat') options.chatId = 'two';
			if (change === 'edit') controller.change('new draft');
			if (change === 'reset') controller.reset();
			if (change === 'destroy') controller.destroy();
			options.onChange.mockClear();
			resolve('must not apply');
			await completion;
			expect(options.onChange).not.toHaveBeenCalled();
			expect(ui.formattedPastePending).toBe(false);
			controller.destroy();
		},
	);
	it.each(['unrelated text', 'log entry\n'.repeat(120_000)])(
		'skips parsing and focus changes for plain clipboard text',
		async (text) => {
			const { ui, paste, options } = fixture();
			paste(text);
			await Promise.resolve();
			expect(parseComposerMarkdownInWorker).not.toHaveBeenCalled();
			expect(ui.formattedDraft).toBeNull();
			expect(document.activeElement).toBe(options.textarea);
		},
	);
	it('keeps the original source exact until an actual edit', async () => {
		vi.mocked(parseComposerMarkdownInWorker).mockResolvedValue(parsed);
		const { ui, paste, options, controller } = fixture();
		paste(table);
		controller.selectMode('formatted');
		await vi.waitFor(() => expect(ui.formattedDraft?.document).toEqual(parsed.document));
		expect(options.onChange).not.toHaveBeenCalled();
		expect(options.composer.inputText).toBe(table);
		controller.change('edited Markdown');
		expect(options.composer.inputText).toBe('edited Markdown');
		controller.destroy();
	});
	it('restores the formatted view of a loaded Markdown draft without changing it', async () => {
		vi.mocked(parseComposerMarkdownInWorker).mockResolvedValue(parsed);
		const { ui, options, controller } = fixture();
		controller.restore();
		await vi.waitFor(() => expect(ui.formattedDraft).toEqual({ source: table, ...parsed }));
		expect(parseComposerMarkdownInWorker).toHaveBeenCalledExactlyOnceWith(
			{ source: table, caret: 0 },
			expect.any(AbortSignal),
		);
		controller.restore();
		expect(parseComposerMarkdownInWorker).toHaveBeenCalledOnce();
		expect(options.onChange).not.toHaveBeenCalled();
		controller.destroy();
	});
	it('leaves a restored draft in Source when Source is preferred', async () => {
		const { ui, options, controller } = fixture();
		options.preferredMode = 'source';
		options.composer.inputText = 'plain notes\nwith two lines';
		controller.restore();
		await Promise.resolve();
		expect(parseComposerMarkdownInWorker).not.toHaveBeenCalled();
		expect(ui.formattedDraft).toBeNull();
		expect(options.onUnavailable).not.toHaveBeenCalled();
		controller.destroy();
	});
	it('opens the file menu for a mention typed in the formatted editor and inserts the choice', () => {
		const { ui, controller } = fixture();
		ui.formattedDraft = { source: table, ...parsed };
		const insert = vi.fn();
		controller.mention({ query: 'src', insert });
		expect(ui.showFileMenu).toBe(true);
		expect(ui.fileQuery).toBe('src');
		controller.insertFileMention('src/app.ts');
		expect(insert).toHaveBeenCalledExactlyOnceWith('src/app.ts');
		expect(ui.showFileMenu).toBe(false);
		controller.mention({ query: 'a', insert });
		controller.reset();
		expect(ui.showFileMenu).toBe(false);
		controller.destroy();
	});
	it('returns a draft without formatting to the plain editor at the same caret', async () => {
		const { ui, options, controller } = fixture();
		ui.formattedDraft = { source: table, ...parsed };
		controller.plain('/cl', 2);
		expect(options.composer.inputText).toBe('/cl');
		expect(ui.formattedDraft).toBeNull();
		options.textarea.value = '/cl';
		await vi.waitFor(() => expect(options.onSourceCaret).toHaveBeenCalledExactlyOnceWith('/cl', 2));
		expect(options.textarea.selectionStart).toBe(2);
		expect(document.activeElement).toBe(options.textarea);
		controller.destroy();
	});
	it('formats after menu focus restoration without taking focus from unrelated controls', async () => {
		let resolve!: (document: ComposerMarkdownDocument | null) => void;
		vi.mocked(parseComposerMarkdownInWorker).mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const { ui, controller } = fixture();
		controller.restore();
		const button = document.createElement('button');
		document.body.append(button);
		button.focus();
		resolve(parsed);
		await vi.waitFor(() => expect(ui.formattedDraft?.document).toEqual(parsed.document));
		const target = document.createElement('div');
		target.tabIndex = 0;
		document.body.append(target);
		controller.focus(target);
		expect(document.activeElement).toBe(button);
		controller.destroy();
	});
	it.each(['chat', 'text', 'hidden', 'reset', 'destroy'])(
		'ignores stale worker completion after %s changes',
		async (change) => {
			let resolve!: (document: ComposerMarkdownDocument | null) => void;
			vi.mocked(parseComposerMarkdownInWorker).mockReturnValue(
				new Promise((done) => {
					resolve = done;
				}),
			);
			const { ui, paste, options, controller } = fixture();
			paste(table);
			controller.selectMode('formatted');
			if (change === 'chat') options.chatId = 'two';
			if (change === 'text') options.composer.inputText = 'new draft';
			if (change === 'hidden') options.canFormat = false;
			if (change === 'reset') controller.reset();
			if (change === 'destroy') controller.destroy();
			resolve(parsed);
			await Promise.resolve();
			await Promise.resolve();
			expect(ui.formattedDraft).toBeNull();
			controller.destroy();
		},
	);
});
