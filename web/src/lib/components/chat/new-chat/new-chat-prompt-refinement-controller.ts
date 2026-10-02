import { tick } from 'svelte';
import { PROMPT_REFINEMENT_DRAFT_MAX_LENGTH } from '$shared/prompt-refinement';
import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte.js';
import { PromptRefinementController } from '$lib/prompt-editor/prompt-refinement-controller.svelte.js';
import { promptRefinementErrorMessage } from '$lib/prompt-editor/prompt-refinement-error-message.js';
import type { NotificationsStore } from '$lib/stores/notifications.svelte.js';
import { transientLayerAttachment } from '$lib/workspace/transient-layer-action.js';
import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id.js';
import type { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import type { NewChatComposerEditorState } from './new-chat-composer-editor-state.svelte.js';

interface NewChatPromptRefinementOptions {
	form: Pick<NewChatFormState, 'firstMessage' | 'contentRevision'>;
	notifications: Pick<NotificationsStore, 'info' | 'error'>;
	transientLayers: TransientLayerRegistry;
	editor: NewChatComposerEditorState;
	get textarea(): HTMLTextAreaElement | undefined;
	get startBlocked(): boolean;
	closePromptSurfaces(): void;
	resizeTextarea(): void;
}

export class NewChatPromptRefinementController {
	readonly layerAttachment;
	readonly #request = new PromptRefinementController();
	#destroyed = false;

	constructor(private readonly options: NewChatPromptRefinementOptions) {
		this.layerAttachment = transientLayerAttachment({
			registry: options.transientLayers,
			id: allocateTransientLayerId('prompt-refinement'),
			kind: 'prompt-transform',
			modality: 'nonmodal',
			onEscape: () => {
				this.cancel();
				return true;
			},
			restoreFocus: () => void this.#focusEditor(),
		});
	}

	get pending(): boolean {
		return this.#request.pending;
	}

	get canStart(): boolean {
		const text = this.options.form.firstMessage;
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
		void this.#focusEditor();
	}

	abort(): void {
		this.#request.cancel();
	}

	destroy(): void {
		this.#destroyed = true;
		this.abort();
	}

	async #run(): Promise<void> {
		const sourceText = this.options.form.firstMessage;
		const sourceRevision = this.options.form.contentRevision;
		this.options.closePromptSurfaces();

		try {
			const result = await this.#request.run({ draft: sourceText, target: 'prompt' });
			if (result.kind !== 'refined') return;
			if (
				this.options.form.contentRevision !== sourceRevision ||
				this.options.form.firstMessage !== sourceText
			) {
				this.options.notifications.info(m.prompt_refinement_draft_changed());
				await this.#focusEditor();
				return;
			}

			const refinedPrompt = result.response.refinedPrompt;
			if (refinedPrompt === sourceText) {
				this.options.notifications.info(m.prompt_refinement_unchanged());
				await this.#focusEditor();
				return;
			}

			this.options.form.firstMessage = refinedPrompt;
			this.options.notifications.info(m.prompt_refinement_refined());
			await this.#focusEditor(refinedPrompt.length);
		} catch (error) {
			this.options.notifications.error(promptRefinementErrorMessage(error));
			await this.#focusEditor();
		}
	}

	async #focusEditor(caret?: number): Promise<void> {
		if (this.options.editor.open) {
			if (caret === undefined) this.options.editor.requestFocus();
			else this.options.editor.moveCaretToEnd(caret);
			await tick();
			return;
		}

		await tick();
		const textarea = this.options.textarea;
		if (this.#destroyed || !textarea) return;
		if (caret !== undefined) textarea.setSelectionRange(caret, caret);
		this.options.resizeTextarea();
		textarea.focus({ preventScroll: true });
	}
}
