import { tick } from 'svelte';
import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import { findSnippetTrigger } from '$lib/chat/composer/snippet-trigger.js';
import type { PromptComposerUiState } from './prompt-composer-state.svelte.js';
import { isComposerMarkdownSized } from './composer-markdown-limits.js';
import type { ComposerInputMode } from '$lib/chat/composer/markdown-input.js';
import {
	parseComposerMarkdownInWorker,
	serializeComposerMarkdownPasteInWorker,
} from './composer-markdown-worker.js';
import type {
	ComposerMarkdownDocument,
	ComposerMarkdownPasteRequest,
} from './composer-markdown-parser.js';
import { loadComposerMarkdownEditor } from './composer-markdown-editor-loader.js';

/** An `@` file mention being typed in the formatted editor. */
export interface ComposerMarkdownMention {
	query: string;
	insert(path: string): void;
}

interface PromptComposerMarkdownOptions {
	ui: PromptComposerUiState;
	composer: Pick<ComposerState, 'inputText' | 'draftRestoreRequest'>;
	get chatId(): string | null;
	get textarea(): HTMLTextAreaElement | undefined;
	get canFormat(): boolean;
	/** Whether the selected agent and model take Markdown; other input stays as typed. */
	get acceptsMarkdown(): boolean;
	get preferredMode(): ComposerInputMode;
	get interactionGeneration(): number;
	/** Prefix that opens the snippet palette; empty where snippets do not apply. */
	get snippetTrigger(): string;
	onChange(text: string): void;
	/** Reports the caret after a draft returns to the plain editor mid-edit. */
	onSourceCaret(text: string, caret: number): void;
	onUnavailable(): void;
}

export class PromptComposerMarkdownController {
	#workerAbort: AbortController | null = null;
	#destroyed = false;
	#focusGeneration = -1;
	#focusOrigin: Element | null = null;
	#mention: ComposerMarkdownMention | null = null;
	#composing = false;
	#restoreRequest: ComposerState['draftRestoreRequest'] | undefined;
	#formatIntent: 'explicit' | 'restore' | null = null;
	#editorLoaded = false;

	constructor(private readonly options: PromptComposerMarkdownOptions) {}

	input(event: InputEvent): void {
		const intent = this.#formatIntent;
		this.reset();
		this.#formatIntent = intent;
		this.#composing = event.isComposing;
		if (intent) void this.#format(this.options.textarea?.selectionStart);
	}

	selectMode(mode: ComposerInputMode): void {
		if (mode === 'source') void this.edit();
		else if (!this.options.ui.formattedDraft) {
			this.#formatIntent = 'explicit';
			void this.#format(this.options.textarea?.selectionStart);
		}
	}

	/** Retries an unfulfilled restore when editing becomes available. */
	restore(): void {
		const request = this.options.composer.draftRestoreRequest;
		if (request !== this.#restoreRequest) {
			this.reset();
			this.#restoreRequest = request;
			if (this.options.preferredMode === 'formatted') this.#formatIntent = 'restore';
		}
		if (this.#formatIntent && !this.options.ui.formattedDraft && !this.#workerAbort) {
			void this.#format();
		}
	}

	reset(): void {
		this.#formatIntent = null;
		this.#composing = false;
		this.#workerAbort?.abort();
		this.#workerAbort = null;
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

	/** Hands source-only actions back to the textarea without changing the preference. */
	plain(text: string, caret: number): void {
		if (!this.options.canFormat || !this.options.ui.formattedDraft) return;
		this.#workerAbort?.abort();
		this.options.onChange(text);
		void this.edit(caret);
	}

	get snippetTrigger(): string {
		return this.options.snippetTrigger;
	}

	/**
	 * Hands a snippet trigger typed in the formatted editor to the plain editor, whose palette
	 * replaces a range of the source. Reports whether the draft was handed over.
	 */
	snippet(text: string, caret: number): boolean {
		const trigger = findSnippetTrigger(text, caret, this.options.snippetTrigger);
		if (!trigger || !this.options.ui.snippetPalette.opensFor(trigger, text)) return false;
		this.plain(text, caret);
		return true;
	}

	change(text: string): void {
		if (!this.options.canFormat || !this.options.ui.formattedDraft) return;
		this.#workerAbort?.abort();
		this.options.onChange(text);
		// Forgets a dismissed snippet trigger once it is deleted, as plain editing does.
		this.options.ui.snippetPalette.updateDetectedTrigger(null, text);
		this.options.ui.formattedDraft = { ...this.options.ui.formattedDraft, source: text };
	}

	overflow(text: string): void {
		this.change(text);
		this.options.onUnavailable();
		void this.edit();
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
			let separator = '';
			if (draft.source && !draft.source.endsWith('\n\n')) {
				separator = draft.source.endsWith('\n') ? '\n' : '\n\n';
			}
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

	async #format(caret?: number): Promise<void> {
		const source = this.options.composer.inputText;
		if (!this.options.canFormat || !this.options.acceptsMarkdown || this.#composing) return;
		if (!isComposerMarkdownSized(source)) {
			this.#formatUnavailable();
			return;
		}
		this.#workerAbort?.abort();
		const abort = new AbortController();
		this.#workerAbort = abort;
		this.options.ui.formatPending = true;
		const chatId = this.options.chatId;
		const generation = this.options.interactionGeneration;
		const focusOrigin =
			caret === undefined ? document.activeElement : (this.options.textarea ?? null);
		const selectionEnd = this.options.textarea?.selectionEnd;
		const empty: ComposerMarkdownDocument = {
			document: { type: 'doc', content: [{ type: 'paragraph' }] },
			sources: [''],
			selection: 1,
		};
		if (source === '' && this.#editorLoaded) {
			this.#workerAbort = null;
			this.#showFormatted(source, empty, generation, focusOrigin);
			return;
		}
		// The editor loads before the swap so keys typed meanwhile still reach the textarea.
		const [parsed, editor] = await Promise.all([
			source === ''
				? Promise.resolve(empty)
				: parseComposerMarkdownInWorker(
						{ source, ...(caret !== undefined ? { caret } : {}) },
						abort.signal,
					).catch(() => null),
			loadComposerMarkdownEditor().catch(() => null),
		]);
		if (this.#workerAbort === abort) {
			this.#workerAbort = null;
			this.options.ui.formatPending = false;
		}
		if (
			this.#destroyed ||
			abort.signal.aborted ||
			!this.options.canFormat ||
			!this.options.acceptsMarkdown ||
			this.options.chatId !== chatId ||
			this.options.composer.inputText !== source
		)
			return;
		if (!parsed || !editor) {
			this.#formatUnavailable();
			return;
		}
		this.#editorLoaded = true;
		if (
			caret !== undefined &&
			(this.options.textarea?.selectionStart !== caret ||
				this.options.textarea?.selectionEnd !== selectionEnd)
		) {
			void this.#format(this.options.textarea?.selectionStart);
			return;
		}
		this.#showFormatted(source, parsed, generation, focusOrigin);
	}

	#formatUnavailable(): void {
		const notify = this.#formatIntent === 'explicit';
		this.#formatIntent = null;
		if (notify) this.options.onUnavailable();
	}

	#showFormatted(
		source: string,
		parsed: ComposerMarkdownDocument,
		generation: number,
		focusOrigin: Element | null,
	): void {
		this.#formatIntent = null;
		this.options.ui.formatPending = false;
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
