import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptComposerMarkdownController } from '../prompt-composer-markdown-controller.js';
import { PromptComposerUiState } from '../prompt-composer-state.svelte.js';
import { parseComposerMarkdownInWorker } from '../composer-markdown-worker.js';
import type { JSONContent } from '@tiptap/core';

vi.mock('../composer-markdown-worker.js', () => ({ parseComposerMarkdownInWorker: vi.fn() }));
const table = '| A | B |\n| - | - |\n| first | second |';
const parsed: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };
function fixture() {
	const ui = new PromptComposerUiState();
	const textarea = document.createElement('textarea');
	document.body.append(textarea);
	textarea.focus();
	const composer = { inputText: table };
	const options = {
		ui,
		composer,
		textarea,
		chatId: 'one',
		canFormat: true,
		interactionGeneration: 0,
		onChange: vi.fn((text: string) => {
			composer.inputText = text;
		}),
		onUnavailable: vi.fn(),
	};
	const controller = new PromptComposerMarkdownController(options);
	function paste(text: string) {
		const data = new DataTransfer();
		data.setData('text/plain', text);
		const event = new ClipboardEvent('paste', { clipboardData: data });
		Object.defineProperty(event, 'target', { value: textarea });
		controller.capturePaste(event);
		controller.input(new InputEvent('input', { inputType: 'insertFromPaste' }));
	}
	return { ui, options, controller, paste };
}
afterEach(() => {
	document.body.replaceChildren();
	vi.resetAllMocks();
});

describe('formatted composer lifecycle', () => {
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
		await vi.waitFor(() => expect(ui.formattedDraft?.document).toEqual(parsed));
		expect(options.onChange).not.toHaveBeenCalled();
		expect(options.composer.inputText).toBe(table);
		controller.change('edited Markdown');
		expect(options.composer.inputText).toBe('edited Markdown');
		controller.destroy();
	});
	it.each(['chat', 'text', 'focus', 'interaction', 'hidden', 'reset', 'destroy'])(
		'ignores stale worker completion after %s changes',
		async (change) => {
			let resolve!: (document: JSONContent | null) => void;
			vi.mocked(parseComposerMarkdownInWorker).mockReturnValue(
				new Promise((done) => {
					resolve = done;
				}),
			);
			const { ui, paste, options, controller } = fixture();
			paste(table);
			if (change === 'chat') options.chatId = 'two';
			if (change === 'text') options.composer.inputText = 'new draft';
			if (change === 'focus') {
				const button = document.createElement('button');
				document.body.append(button);
				button.focus();
			}
			if (change === 'interaction') options.interactionGeneration++;
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
