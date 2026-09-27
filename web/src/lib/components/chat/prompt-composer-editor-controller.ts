import { tick } from 'svelte';
import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import {
	promptEditorSelectionFromTextarea,
	restorePromptEditorSelection,
	type PromptEditorSelection,
} from '$lib/prompt-editor/prompt-editor-selection.js';
import type { PromptComposerUiState } from './prompt-composer-state.svelte.js';

interface PromptComposerEditorControllerOptions {
	get ui(): PromptComposerUiState;
	composer: Pick<ComposerState, 'inputText' | 'queueDraftSave'>;
	get selectedChatId(): string | null;
	get textarea(): HTMLTextAreaElement | undefined;
	get isVisible(): boolean;
	get isDisabled(): boolean;
	get promptTransformPending(): boolean;
	get snippetTrigger(): unknown;
	get resizeTextarea(): () => void;
}

export class PromptComposerEditorController {
	#handledOpenRequestId = 0;
	#destroyed = false;

	constructor(private readonly options: PromptComposerEditorControllerOptions) {}

	open(): boolean {
		const { ui } = this.options;
		const chatId = this.options.selectedChatId;
		if (!chatId) return false;
		if (ui.composerEditorOpen && ui.composerEditorChatId === chatId) {
			ui.openComposerEditor(chatId, ui.composerEditorSelection);
			return true;
		}
		const textarea = this.options.textarea;
		if (
			!textarea ||
			!this.options.isVisible ||
			this.options.isDisabled ||
			this.options.promptTransformPending
		) {
			return false;
		}
		ui.closeFileMenu();
		ui.closeSlashMenu();
		ui.snippetPalette.dismiss();
		const selection = promptEditorSelectionFromTextarea(textarea);
		textarea.focus({ preventScroll: true });
		ui.openComposerEditor(chatId, selection);
		return true;
	}

	handleOpenRequest(requestId: number): void {
		if (requestId === 0 || requestId === this.#handledOpenRequestId) return;
		if (this.open()) this.#handledOpenRequestId = requestId;
	}

	destroy(): void {
		this.#destroyed = true;
	}

	updateText(chatId: string, text: string): void {
		if (
			this.options.promptTransformPending ||
			this.options.isDisabled ||
			this.options.selectedChatId !== chatId ||
			this.options.ui.composerEditorChatId !== chatId ||
			this.options.composer.inputText === text
		) {
			return;
		}
		this.options.composer.inputText = text;
		this.options.composer.queueDraftSave(chatId, text);
	}

	updateSelection(chatId: string, selection: PromptEditorSelection): void {
		this.options.ui.updateComposerEditorSelection(chatId, selection);
	}

	close(restoreFocus = true): void {
		const chatId = this.options.ui.composerEditorChatId;
		const selection = this.options.ui.composerEditorSelection;
		this.options.ui.closeComposerEditor();
		if (restoreFocus && chatId) void this.#restoreComposer(chatId, selection);
	}

	async #restoreComposer(chatId: string, selection: PromptEditorSelection): Promise<void> {
		await tick();
		if (this.#destroyed) return;
		const textarea = this.options.textarea;
		if (this.options.selectedChatId !== chatId || !textarea || !this.options.isVisible) return;
		textarea.focus({ preventScroll: true });
		restorePromptEditorSelection(textarea, selection);
		const restoredSelection = promptEditorSelectionFromTextarea(textarea);
		if (!this.options.promptTransformPending) {
			this.options.ui.updateTriggers(
				this.options.composer.inputText,
				restoredSelection.head,
				this.options.snippetTrigger,
			);
		}
		this.options.resizeTextarea();
	}
}
