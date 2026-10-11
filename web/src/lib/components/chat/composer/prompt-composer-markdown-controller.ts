import { tick } from 'svelte';
import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import type { PromptComposerUiState } from './prompt-composer-state.svelte.js';
import { isComposerMarkdownSized, isMarkdownTableCandidate } from './composer-markdown-limits.js';
import {
	parseComposerMarkdownInWorker,
	serializeComposerMarkdownPasteInWorker,
} from './composer-markdown-worker.js';
import type { ComposerMarkdownPasteRequest } from './composer-markdown-parser.js';

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
	#workerAbort: AbortController | null = null;
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
		this.#workerAbort?.abort();
		this.#workerAbort = null;
		this.#pastedText = null;
		this.options.ui.closeFormattedDraft();
		this.#focusGeneration = -1;
	}

	change(text: string): void {
		if (!this.options.canFormat || !this.options.ui.formattedDraft) return;
		this.#workerAbort?.abort();
		this.options.onChange(text);
		this.options.ui.formattedDraft = { ...this.options.ui.formattedDraft, source: text };
		if (!isComposerMarkdownSized(text)) void this.edit();
	}

	async pasteSource(request: ComposerMarkdownPasteRequest): Promise<void> {
		const draft = this.options.ui.formattedDraft;
		if (!this.options.canFormat || !draft) return;
		this.#workerAbort?.abort();
		const abort = new AbortController();
		this.#workerAbort = abort;
		this.options.ui.formattedPastePending = true;
		const chatId = this.options.chatId;
		const generation = this.options.interactionGeneration;
		const text = await serializeComposerMarkdownPasteInWorker(request, abort.signal).catch(
			() => null,
		);
		if (this.#workerAbort === abort) {
			this.#workerAbort = null;
			this.options.ui.formattedPastePending = false;
		}
		if (
			this.#destroyed ||
			abort.signal.aborted ||
			!this.options.canFormat ||
			this.options.chatId !== chatId ||
			this.options.ui.formattedDraft !== draft ||
			this.options.composer.inputText !== draft.source
		)
			return;
		if (text === null) {
			this.options.onUnavailable();
			return;
		}
		this.options.onChange(text);
		if (generation === this.options.interactionGeneration) void this.edit();
		else this.reset();
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
				document.activeElement === this.#focusOrigin ||
				this.options.textarea?.closest('[data-composer]')?.contains(document.activeElement))
		)
			target.focus({ preventScroll: true });
	}

	async edit(): Promise<void> {
		const chatId = this.options.chatId;
		const generation = this.options.interactionGeneration;
		this.reset();
		await tick();
		if (
			!this.#destroyed &&
			this.options.canFormat &&
			this.options.chatId === chatId &&
			generation === this.options.interactionGeneration
		) {
			const textarea = this.options.textarea;
			textarea?.focus({ preventScroll: true });
			textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
		}
	}

	async openSnippets(): Promise<void> {
		const chatId = this.options.chatId;
		if (this.options.ui.formattedDraft) await this.edit();
		if (!this.#destroyed && this.options.canFormat && this.options.chatId === chatId) {
			this.options.ui.snippetPalette.openFromMenu();
		}
	}

	async #format(pastedText?: string): Promise<void> {
		const source = this.options.composer.inputText;
		if (!this.options.canFormat || !source.trim()) return;
		if (!isComposerMarkdownSized(source)) {
			if (pastedText === undefined) this.options.onUnavailable();
			return;
		}
		this.#workerAbort?.abort();
		const abort = new AbortController();
		this.#workerAbort = abort;
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
			this.options.interactionGeneration !== generation
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
