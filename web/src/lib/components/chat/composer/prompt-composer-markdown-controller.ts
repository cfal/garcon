import { tick } from 'svelte';
import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import type { PromptComposerUiState } from './prompt-composer-state.svelte.js';
import { isComposerMarkdownSized, isMarkdownCandidate } from './composer-markdown-limits.js';
import {
	parseComposerMarkdownInWorker,
	serializeComposerMarkdownPasteInWorker,
} from './composer-markdown-worker.js';
import type { ComposerMarkdownPasteRequest } from './composer-markdown-parser.js';
import { loadComposerMarkdownEditor } from './composer-markdown-editor-loader.js';

/** An `@` file mention being typed in the formatted editor. */
export interface ComposerMarkdownMention {
	query: string;
	insert(path: string): void;
}

interface PromptComposerMarkdownOptions {
	ui: PromptComposerUiState;
	composer: Pick<ComposerState, 'inputText'>;
	get chatId(): string | null;
	get textarea(): HTMLTextAreaElement | undefined;
	get canFormat(): boolean;
	get interactionGeneration(): number;
	onChange(text: string): void;
	/** Reports the caret after a draft returns to the plain editor mid-edit. */
	onSourceCaret(text: string, caret: number): void;
	onUnavailable(): void;
}

export class PromptComposerMarkdownController {
	#workerAbort: AbortController | null = null;
	#pastedText: string | null = null;
	#destroyed = false;
	#focusGeneration = -1;
	#focusOrigin: Element | null = null;
	#mention: ComposerMarkdownMention | null = null;

	constructor(private readonly options: PromptComposerMarkdownOptions) {}

	capturePaste(event: ClipboardEvent): void {
		this.#pastedText = null;
		if (event.target !== this.options.textarea) return;
		const text = event.clipboardData?.getData('text/plain') ?? '';
		if (isMarkdownCandidate(text)) this.#pastedText = text;
	}

	input(event: InputEvent): void {
		const pastedText = this.#pastedText;
		this.reset();
		if (event.inputType === 'insertFromPaste' && pastedText !== null) void this.#format(pastedText);
	}

	open(): void {
		void this.#format();
	}

	/** Shows a loaded Markdown draft formatted, as it was when pasted. */
	restore(): void {
		const source = this.options.composer.inputText;
		if (this.options.ui.formattedDraft || !isMarkdownCandidate(source)) return;
		void this.#format(source);
	}

	reset(): void {
		this.#workerAbort?.abort();
		this.#workerAbort = null;
		this.#pastedText = null;
		this.options.ui.closeFormattedDraft();
		this.#focusGeneration = -1;
		if (this.#mention) this.mention(null);
	}

	/** Shows the file menu for a mention typed in the formatted editor. */
	mention(mention: ComposerMarkdownMention | null): void {
		this.#mention = mention;
		// The menu reads only the query; the editor owns the range the mention replaces.
		this.options.ui.setFileMentionTrigger(
			mention ? { start: 0, end: 0, query: mention.query } : null,
		);
	}

	insertFileMention(path: string): void {
		const mention = this.#mention;
		this.mention(null);
		mention?.insert(path);
	}

	/** Returns a draft with no formatting left to the plain editor at the same caret. */
	plain(text: string, caret: number): void {
		if (!this.options.canFormat || !this.options.ui.formattedDraft) return;
		this.#workerAbort?.abort();
		this.options.onChange(text);
		void this.edit(caret);
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
			// The paste was intercepted, so its text survives only if it is written here. Its
			// position in the document is unknown without serialization; it goes to the end.
			const separator = /\n\n$|^$/.test(draft.source) ? '' : draft.source.endsWith('\n') ? '\n' : '\n\n';
			this.options.onChange(draft.source + separator + request.text);
			this.options.onUnavailable();
		} else {
			this.options.onChange(text);
		}
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

	async edit(caret?: number): Promise<void> {
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
			if (!textarea) return;
			const position = caret ?? textarea.value.length;
			textarea.focus({ preventScroll: true });
			textarea.setSelectionRange(position, position);
			if (caret !== undefined) this.options.onSourceCaret(textarea.value, position);
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
		// The editor loads before the swap so keys typed meanwhile still reach the textarea.
		const [parsed] = await Promise.all([
			parseComposerMarkdownInWorker({ source, pastedText }, abort.signal).catch(() => null),
			loadComposerMarkdownEditor().catch(() => null),
		]);
		if (
			this.#destroyed ||
			abort.signal.aborted ||
			!this.options.canFormat ||
			this.options.chatId !== chatId ||
			this.options.composer.inputText !== source ||
			this.options.interactionGeneration !== generation
		)
			return;
		if (!parsed) {
			if (pastedText === undefined) this.options.onUnavailable();
			return;
		}
		this.#focusOrigin = focusOrigin;
		this.#focusGeneration = generation;
		this.options.ui.formattedDraft = { source, ...parsed };
		this.options.ui.closeFileMenu();
		this.options.ui.closeSlashMenu();
		this.options.ui.snippetPalette.dismiss();
	}

	destroy(): void {
		this.#destroyed = true;
		this.reset();
	}
}
