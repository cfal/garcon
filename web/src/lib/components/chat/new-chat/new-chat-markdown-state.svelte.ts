import { untrack } from 'svelte';
import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte.js';
import type { ComposerInputMode } from '$lib/chat/composer/markdown-input.js';
import { findSnippetTrigger } from '$lib/chat/composer/snippet-trigger.js';
import { PromptComposerMarkdownController } from '../composer/prompt-composer-markdown-controller.js';
import { PromptComposerUiState } from '../composer/prompt-composer-state.svelte.js';

interface NewChatMarkdownOptions {
	form: Pick<NewChatFormState, 'firstMessage'>;
	get generation(): number;
	get textarea(): HTMLTextAreaElement | undefined;
	get canFormat(): boolean;
	get acceptsMarkdown(): boolean;
	get preferredMode(): ComposerInputMode;
	get interactionGeneration(): number;
	get snippetTrigger(): string;
	onUnavailable(): void;
}

/** Binds the shared formatted input lifecycle to one unsent New Chat draft. */
export class NewChatMarkdownState {
	readonly ui = new PromptComposerUiState();
	readonly controller: PromptComposerMarkdownController;

	constructor(private readonly options: NewChatMarkdownOptions) {
		const ui = this.ui;
		const markdownInput = $derived(options.acceptsMarkdown);
		const restoreRequest = $derived({ chatId: 'new-chat', requestId: options.generation });
		const controller = new PromptComposerMarkdownController({
			ui,
			composer: {
				get inputText() {
					return options.form.firstMessage;
				},
				get draftRestoreRequest() {
					return restoreRequest;
				},
			},
			get chatId() {
				return String(options.generation);
			},
			get textarea() {
				return options.textarea;
			},
			get canFormat() {
				return options.canFormat;
			},
			get sourcePaletteOpen() {
				return ui.snippetPalette.isOpen;
			},
			get acceptsMarkdown() {
				return markdownInput;
			},
			get preferredMode() {
				return options.preferredMode;
			},
			get interactionGeneration() {
				return options.interactionGeneration;
			},
			get snippetTrigger() {
				return options.snippetTrigger;
			},
			onChange(text) {
				options.form.firstMessage = text;
			},
			onSourceCaret(text, caret) {
				ui.snippetPalette.updateDetectedTrigger(
					findSnippetTrigger(text, caret, options.snippetTrigger),
					text,
				);
			},
			onUnavailable: () => options.onUnavailable(),
		});
		this.controller = controller;
		$effect(() => {
			void markdownInput;
			untrack(() => controller.inputFormatChanged());
		});
		$effect(() => {
			if (ui.formattedDraft && !this.draft) untrack(() => controller.reset());
		});
		$effect(() => {
			void options.canFormat;
			void restoreRequest;
			void options.preferredMode;
			if (markdownInput) untrack(() => controller.restore());
		});
	}

	get draft() {
		return this.ui.formattedDraft?.source === this.options.form.firstMessage
			? this.ui.formattedDraft
			: null;
	}
}
