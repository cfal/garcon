import { tick } from 'svelte';
import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import type { PromptComposerUiState } from './prompt-composer-state.svelte.js';
import { isComposerMarkdownSized, isMarkdownTableCandidate } from './composer-markdown-limits.js';
import { parseComposerMarkdownInWorker } from './composer-markdown-worker.js';

interface PromptComposerMarkdownOptions {
	ui: PromptComposerUiState;
	composer: Pick<ComposerState, 'inputText'>;
	get chatId(): string | null;
	get textarea(): HTMLTextAreaElement | undefined;
	get canFormat(): boolean;
	get interactionGeneration(): number;
	onChange(text: string): void;
	onUnavailable(): void;
}

export class PromptComposerMarkdownController {
	#parseAbort: AbortController | null = null;
	#pastedText: string | null = null;
	#destroyed = false;
	#focusGeneration = -1;
	#focusOrigin: Element | null = null;

	constructor(private readonly options: PromptComposerMarkdownOptions) {}

	capturePaste(event: ClipboardEvent): void {
		this.#pastedText = null;
		if (event.target !== this.options.textarea) return;
		const text = event.clipboardData?.getData('text/plain') ?? '';
		if (isMarkdownTableCandidate(text)) this.#pastedText = text;
	}

	input(event: InputEvent): void {
		const pastedText = this.#pastedText;
		this.reset();
		if (event.inputType === 'insertFromPaste' && pastedText !== null) void this.#format(pastedText);
	}

	open(): void {
		void this.#format();
	}

	reset(): void {
		this.#parseAbort?.abort();
		this.#parseAbort = null;
		this.#pastedText = null;
		this.options.ui.closeFormattedDraft();
		this.#focusGeneration = -1;
	}

	change(text: string): void {
		if (!this.options.canFormat || !this.options.ui.formattedDraft) return;
		this.options.onChange(text);
		this.options.ui.formattedDraft = { ...this.options.ui.formattedDraft, source: text };
		if (!isComposerMarkdownSized(text)) void this.edit();
	}

	pasteSource(text: string): void {
		if (!this.options.canFormat) return;
		this.options.onChange(text);
		void this.edit();
	}

	focus(target: HTMLElement): void {
		this.options.ui.formattedTarget = target;
		if (
			!this.#destroyed &&
			this.options.canFormat &&
			this.options.ui.formattedDraft?.source === this.options.composer.inputText &&
			this.#focusGeneration === this.options.interactionGeneration &&
			(document.activeElement === document.body ||
				document.activeElement === this.options.textarea ||
				document.activeElement === this.#focusOrigin)
		)
			target.focus({ preventScroll: true });
	}

	async edit(): Promise<void> {
		const chatId = this.options.chatId;
		this.reset();
		await tick();
		if (!this.#destroyed && this.options.canFormat && this.options.chatId === chatId) {
			this.options.textarea?.focus({ preventScroll: true });
		}
	}

	async #format(pastedText?: string): Promise<void> {
		const source = this.options.composer.inputText;
		if (!this.options.canFormat || !source.trim()) return;
		if (!isComposerMarkdownSized(source)) {
			if (pastedText === undefined) this.options.onUnavailable();
			return;
		}
		this.#parseAbort?.abort();
		const abort = new AbortController();
		this.#parseAbort = abort;
		const chatId = this.options.chatId;
		const generation = this.options.interactionGeneration;
		const focusOrigin = document.activeElement;
		const documentContent = await parseComposerMarkdownInWorker(
			{ source, pastedText },
			abort.signal,
		).catch(() => null);
		if (
			this.#destroyed ||
			abort.signal.aborted ||
			!this.options.canFormat ||
			this.options.chatId !== chatId ||
			this.options.composer.inputText !== source ||
			this.options.interactionGeneration !== generation ||
			document.activeElement !== focusOrigin
		)
			return;
		if (!documentContent) {
			if (pastedText === undefined) this.options.onUnavailable();
			return;
		}
		this.#focusOrigin = focusOrigin;
		this.#focusGeneration = generation;
		this.options.ui.formattedDraft = { source, document: documentContent };
		this.options.ui.closeFileMenu();
		this.options.ui.closeSlashMenu();
		this.options.ui.snippetPalette.dismiss();
	}

	destroy(): void {
		this.#destroyed = true;
		this.reset();
	}
}
