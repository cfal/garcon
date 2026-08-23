import { tick } from 'svelte';
import { PROMPT_REFINEMENT_DRAFT_MAX_LENGTH } from '$shared/prompt-refinement';
import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import { PromptRefinementController } from '$lib/prompt-editor/prompt-refinement-controller.svelte.js';
import { promptRefinementErrorMessage } from '$lib/prompt-editor/prompt-refinement-error-message.js';
import type { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { NotificationsStore } from '$lib/stores/notifications.svelte.js';
import { transientLayerAttachment } from '$lib/workspace/transient-layer-action.js';
import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id.js';
import type { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import type { PromptComposerUiState } from './prompt-composer-state.svelte.js';

interface PromptComposerRefinementOptions {
	composer: Pick<
		ComposerState,
		'inputText' | 'contentRevision' | 'queueDraftSave' | 'isDragActive'
	>;
	sessions: Pick<ChatSessionsStore, 'selectedChatId'>;
	notifications: Pick<NotificationsStore, 'info' | 'error'>;
	ui: PromptComposerUiState;
	transientLayers: TransientLayerRegistry;
	get textarea(): HTMLTextAreaElement | undefined;
	get visible(): boolean;
	get presented(): boolean;
	get startBlocked(): boolean;
	resizeTextarea(): void;
}

export class PromptComposerRefinementController {
	readonly layerAttachment;
	readonly #request = new PromptRefinementController();
	#destroyed = false;

	constructor(private readonly options: PromptComposerRefinementOptions) {
		this.layerAttachment = transientLayerAttachment({
			registry: options.transientLayers,
			id: allocateTransientLayerId('prompt-refinement'),
			kind: 'prompt-transform',
			modality: 'nonmodal',
			onEscape: () => {
				this.cancel();
				return true;
			},
			restoreFocus: () => void this.#focusSelectedChat(),
		});
	}

	get pending(): boolean {
		return this.#request.pending;
	}

	get canStart(): boolean {
		const text = this.options.composer.inputText;
		return (
			!this.options.startBlocked &&
			!this.pending &&
			text.trim().length > 0 &&
			text.length <= PROMPT_REFINEMENT_DRAFT_MAX_LENGTH
		);
	}

	handleAction(): void {
		if (this.pending) {
			this.cancel();
			return;
		}
		if (this.canStart) void this.#run();
	}

	cancel(): void {
		if (!this.pending) return;
		this.#request.cancel();
		void this.#focusSelectedChat();
	}

	abort(): void {
		this.#request.cancel();
	}

	destroy(): void {
		this.#destroyed = true;
		this.abort();
	}

	async #run(): Promise<void> {
		const sourceChatId = this.options.sessions.selectedChatId;
		if (!sourceChatId) return;
		const sourceText = this.options.composer.inputText;
		const sourceRevision = this.options.composer.contentRevision;
		this.options.ui.closeFileMenu();
		this.options.ui.closeSlashMenu();
		this.options.ui.snippetPalette.dismiss();
		this.options.composer.isDragActive = false;

		try {
			const result = await this.#request.run(sourceText);
			if (result.kind !== 'refined') return;
			if (
				this.options.sessions.selectedChatId !== sourceChatId ||
				this.options.composer.contentRevision !== sourceRevision ||
				this.options.composer.inputText !== sourceText
			) {
				this.options.notifications.info(m.prompt_refinement_draft_changed());
				await this.#focusTarget(sourceChatId);
				return;
			}

			const refinedPrompt = result.response.refinedPrompt;
			if (refinedPrompt === sourceText) {
				this.options.notifications.info(m.prompt_refinement_unchanged());
				await this.#focusTarget(sourceChatId);
				return;
			}

			const focus = this.#focusTarget(sourceChatId, refinedPrompt.length);
			this.options.composer.inputText = refinedPrompt;
			this.options.composer.queueDraftSave(sourceChatId, refinedPrompt);
			this.options.notifications.info(m.prompt_refinement_refined());
			await focus;
		} catch (error) {
			this.options.notifications.error(promptRefinementErrorMessage(error));
			await this.#focusTarget(sourceChatId);
		}
	}

	async #focusSelectedChat(): Promise<void> {
		const chatId = this.options.sessions.selectedChatId;
		if (chatId) await this.#focusTarget(chatId);
	}

	async #focusTarget(chatId: string, caret?: number): Promise<void> {
		const { ui } = this.options;
		if (ui.composerEditorOpen && ui.composerEditorChatId === chatId && this.options.presented) {
			if (caret === undefined) ui.requestComposerEditorFocus();
			else ui.moveComposerEditorCaretToEnd(chatId, caret);
			await tick();
			return;
		}

		await tick();
		const textarea = this.options.textarea;
		if (
			this.#destroyed ||
			this.options.sessions.selectedChatId !== chatId ||
			!this.options.visible ||
			!textarea
		) {
			return;
		}
		if (caret !== undefined) textarea.setSelectionRange(caret, caret);
		this.options.resizeTextarea();
		textarea.focus({ preventScroll: true });
	}
}
