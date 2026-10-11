import { tick } from 'svelte';
import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import type { PromptComposerUiState } from './prompt-composer-state.svelte.js';

interface PromptComposerMarkdownOptions {
	ui: PromptComposerUiState;
	composer: Pick<ComposerState, 'inputText'>;
	get chatId(): string | null;
	get textarea(): HTMLTextAreaElement | undefined;
	get canPreview(): boolean;
	get visible(): boolean;
	get interactionGeneration(): number;
}

export class PromptComposerMarkdownController {
	#requestId = 0;
	#destroyed = false;

	constructor(private readonly options: PromptComposerMarkdownOptions) {}

	open(): void {
		if (!this.options.canPreview || !this.options.composer.inputText.trim()) return;
		const { ui } = this.options;
		ui.markdownPreviewText = this.options.composer.inputText;
		ui.closeFileMenu();
		ui.closeSlashMenu();
		ui.snippetPalette.dismiss();
	}

	reset(): void {
		this.#requestId += 1;
		this.options.ui.markdownPreviewText = null;
	}

	async edit(): Promise<void> {
		const chatId = this.options.chatId;
		this.reset();
		await tick();
		if (!this.#destroyed && this.options.visible && this.options.chatId === chatId) {
			this.options.textarea?.focus({ preventScroll: true });
		}
	}

	previewPaste(source: string): void {
		const requestId = ++this.#requestId;
		const chatId = this.options.chatId;
		const interactionGeneration = this.options.interactionGeneration;
		void import('./composer-markdown.js')
			.then(({ hasMarkdownTable }) => {
				if (
					!this.#destroyed &&
					this.#requestId === requestId &&
					this.options.chatId === chatId &&
					this.options.interactionGeneration === interactionGeneration &&
					this.options.composer.inputText === source &&
					document.activeElement === this.options.textarea &&
					hasMarkdownTable(source)
				) {
					this.open();
				}
			})
			.catch(() => {
				// Failed preview loading leaves the editable draft intact.
			});
	}

	destroy(): void {
		this.#destroyed = true;
		this.reset();
	}
}
