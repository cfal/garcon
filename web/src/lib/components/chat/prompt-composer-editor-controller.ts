import { tick } from 'svelte';
import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import {
	composerEditorSelectionFromTextarea,
	restoreComposerEditorSelection,
	type ComposerEditorSelection,
} from '$lib/chat/composer/composer-editor-selection.js';
import type { PromptComposerUiState } from './prompt-composer-state.svelte.js';

interface PromptComposerEditorControllerOptions {
	ui: PromptComposerUiState;
	composer: Pick<ComposerState, 'inputText' | 'queueDraftSave'>;
	get selectedChatId(): string | null;
	get textarea(): HTMLTextAreaElement | undefined;
	get isVisible(): boolean;
	get isDisabled(): boolean;
	get promptTransformPending(): boolean;
	get snippetTrigger(): unknown;
	resizeTextarea: () => void;
}

export class PromptComposerEditorController {
	#handledOpenRequestId = 0;

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
		const selection = composerEditorSelectionFromTextarea(textarea);
		textarea.focus({ preventScroll: true });
		ui.openComposerEditor(chatId, selection);
		return true;
	}

	handleOpenRequest(requestId: number): void {
		if (requestId === 0 || requestId === this.#handledOpenRequestId) return;
		if (this.open()) this.#handledOpenRequestId = requestId;
	}

	updateText(chatId: string, text: string): void {
		if (
			this.options.selectedChatId !== chatId ||
			this.options.ui.composerEditorChatId !== chatId ||
			this.options.composer.inputText === text
		) {
			return;
		}
		this.options.composer.inputText = text;
		this.options.composer.queueDraftSave(chatId, text);
	}

	updateSelection(chatId: string, selection: ComposerEditorSelection): void {
		this.options.ui.updateComposerEditorSelection(chatId, selection);
	}

	close(restoreFocus = true): void {
		const chatId = this.options.ui.composerEditorChatId;
		const selection = this.options.ui.composerEditorSelection;
		this.options.ui.closeComposerEditor();
		if (restoreFocus && chatId) void this.#restoreComposer(chatId, selection);
	}

	async #restoreComposer(chatId: string, selection: ComposerEditorSelection): Promise<void> {
		await tick();
		const textarea = this.options.textarea;
		if (this.options.selectedChatId !== chatId || !textarea || !this.options.isVisible) return;
		textarea.focus({ preventScroll: true });
		restoreComposerEditorSelection(textarea, selection);
		const restoredSelection = composerEditorSelectionFromTextarea(textarea);
		this.options.ui.updateTriggers(
			this.options.composer.inputText,
			restoredSelection.head,
			this.options.snippetTrigger,
		);
		this.options.resizeTextarea();
	}
}
