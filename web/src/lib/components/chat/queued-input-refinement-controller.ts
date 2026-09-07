import { tick } from 'svelte';
import { PROMPT_REFINEMENT_DRAFT_MAX_LENGTH } from '$shared/prompt-refinement';
import type { QueuedInputEditorState } from '$lib/chat/conversation/queued-input-editor-state.svelte.js';
import { PromptRefinementController } from '$lib/prompt-editor/prompt-refinement-controller.svelte.js';
import { promptRefinementErrorMessage } from '$lib/prompt-editor/prompt-refinement-error-message.js';
import type { PromptEditorDialogState } from '$lib/prompt-editor/prompt-editor-dialog-state.svelte.js';
import type { NotificationsStore } from '$lib/stores/notifications.svelte.js';
import { transientLayerAttachment } from '$lib/workspace/transient-layer-action.js';
import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id.js';
import type { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
import * as m from '$lib/paraglide/messages.js';

interface QueuedInputRefinementOptions {
	editor: QueuedInputEditorState;
	expandedEditor: PromptEditorDialogState;
	notifications: Pick<NotificationsStore, 'info' | 'error'>;
	transientLayers: TransientLayerRegistry;
	get textarea(): HTMLTextAreaElement | null;
	get startBlocked(): boolean;
}

// Refines the queued-input draft in place. Lives at queue dialog lifetime so a
// pending request survives the draft card relocating from its inline row to the
// departed-draft recovery slot. Results are applied only when the editor session
// and draft text still match the captured source.
export class QueuedInputRefinementController {
	readonly layerAttachment;
	readonly #request = new PromptRefinementController();
	#destroyed = false;

	constructor(private readonly options: QueuedInputRefinementOptions) {
		this.layerAttachment = transientLayerAttachment({
			registry: options.transientLayers,
			id: allocateTransientLayerId('queued-input-refinement'),
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

	// Refinement stays available across conflict, sent, and removed phases: the
	// draft is preserved there and refining it before queueing it again is valid.
	get canStart(): boolean {
		const { editor } = this.options;
		return (
			!this.options.startBlocked &&
			!this.pending &&
			editor.phase !== 'closed' &&
			editor.phase !== 'steering' &&
			!editor.mutationBlocked &&
			editor.mutation === 'idle' &&
			!editor.queueDraftOutcomeUnknown &&
			editor.draft.trim().length > 0 &&
			editor.draft.length <= PROMPT_REFINEMENT_DRAFT_MAX_LENGTH
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
		const { editor } = this.options;
		const entryId = editor.entryId;
		if (!entryId) return;
		const sessionRevision = editor.sessionRevision;
		const sourceText = editor.draft;

		try {
			const result = await this.#request.run({ draft: sourceText, target: 'prompt' });
			if (result.kind !== 'refined') return;
			if (!editor.matchesSession(entryId, sessionRevision) || editor.draft !== sourceText) {
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

			editor.draft = refinedPrompt;
			this.options.notifications.info(m.prompt_refinement_refined());
			await this.#focusEditor(refinedPrompt.length);
		} catch (error) {
			this.options.notifications.error(promptRefinementErrorMessage(error));
			await this.#focusEditor();
		}
	}

	async #focusEditor(caret?: number): Promise<void> {
		if (this.#destroyed) return;
		if (this.options.expandedEditor.open) {
			if (caret === undefined) this.options.expandedEditor.requestFocus();
			else this.options.expandedEditor.moveCaretToEnd(caret);
			await tick();
			return;
		}

		await tick();
		const textarea = this.options.textarea;
		if (this.#destroyed || !textarea) return;
		if (caret !== undefined) textarea.setSelectionRange(caret, caret);
		textarea.focus({ preventScroll: true });
	}
}
