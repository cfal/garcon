import { tick } from 'svelte';
import { SNIPPET_TEMPLATE_MAX_LENGTH } from '$shared/snippets';
import { PromptRefinementController } from '$lib/prompt-editor/prompt-refinement-controller.svelte.js';
import { promptRefinementErrorMessage } from '$lib/prompt-editor/prompt-refinement-error-message.js';
import type { NotificationsStore } from '$lib/stores/notifications.svelte.js';
import { transientLayerAttachment } from '$lib/workspace/transient-layer-action.js';
import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id.js';
import type { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import type { PromptEditorDialogState } from '$lib/prompt-editor/prompt-editor-dialog-state.svelte.js';
import type { SnippetFormState } from './snippet-form-state.svelte.js';

interface SnippetTemplateRefinementOptions {
	form: SnippetFormState;
	editor: PromptEditorDialogState;
	notifications: Pick<NotificationsStore, 'info' | 'error'>;
	transientLayers: TransientLayerRegistry;
	get textarea(): HTMLTextAreaElement | null;
	get startBlocked(): boolean;
	isCurrentForm(): boolean;
}

export class SnippetTemplateRefinementController {
	readonly layerAttachment;
	readonly #request = new PromptRefinementController();
	#destroyed = false;

	constructor(private readonly options: SnippetTemplateRefinementOptions) {
		this.layerAttachment = transientLayerAttachment({
			registry: options.transientLayers,
			id: allocateTransientLayerId('snippet-template-refinement'),
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
		const text = this.options.form.template;
		return (
			this.options.isCurrentForm() &&
			!this.options.startBlocked &&
			!this.pending &&
			text.trim().length > 0 &&
			text.length <= SNIPPET_TEMPLATE_MAX_LENGTH
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
		const sourceText = this.options.form.template;
		const sourceRevision = this.options.form.templateRevision;

		try {
			const result = await this.#request.run({ draft: sourceText, target: 'snippet-template' });
			if (result.kind !== 'refined' || !this.options.isCurrentForm()) return;
			if (
				this.options.form.templateRevision !== sourceRevision ||
				this.options.form.template !== sourceText
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

			this.options.form.template = refinedPrompt;
			this.options.notifications.info(m.prompt_refinement_refined());
			await this.#focusEditor(refinedPrompt.length);
		} catch (error) {
			if (!this.options.isCurrentForm()) return;
			this.options.notifications.error(promptRefinementErrorMessage(error));
			await this.#focusEditor();
		}
	}

	async #focusEditor(caret?: number): Promise<void> {
		if (this.#destroyed || !this.options.isCurrentForm()) return;
		if (this.options.editor.open) {
			if (caret === undefined) this.options.editor.requestFocus();
			else this.options.editor.moveCaretToEnd(caret);
			await tick();
			return;
		}

		await tick();
		const textarea = this.options.textarea;
		if (this.#destroyed || !this.options.isCurrentForm() || !textarea) return;
		if (caret !== undefined) textarea.setSelectionRange(caret, caret);
		textarea.focus({ preventScroll: true });
	}
}
