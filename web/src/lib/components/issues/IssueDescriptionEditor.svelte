<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { getNotifications, getTransientLayers } from '$lib/context';
	import type { IssueDraftState } from '$lib/issues/drafts/issue-draft-state.svelte.js';
	import PromptTextField from '$lib/components/prompt-editor/PromptTextField.svelte';
	import PromptEditorDialog from '$lib/components/prompt-editor/PromptEditorDialog.svelte';
	import { PromptEditorDialogState } from '$lib/prompt-editor/prompt-editor-dialog-state.svelte.js';
	import { PromptRefinementController } from '$lib/prompt-editor/prompt-refinement-controller.svelte.js';
	import { promptRefinementErrorMessage } from '$lib/prompt-editor/prompt-refinement-error-message.js';
	import {
		promptEditorSelectionFromTextarea,
		restorePromptEditorSelection,
	} from '$lib/prompt-editor/prompt-editor-selection.js';
	import { transientLayerAttachment } from '$lib/workspace/transient-layer-action.js';
	import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id.js';
	import { normalizeRefinePromptRequest } from '$shared/prompt-refinement';
	import IssueMarkdown from './IssueMarkdown.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		draft,
		onkeydown,
		onPendingChange,
		active = true,
	}: {
		draft: IssueDraftState;
		onkeydown: (event: KeyboardEvent) => void;
		onPendingChange: (pending: boolean) => void;
		active?: boolean;
	} = $props();
	const id = $props.id();
	const notifications = getNotifications();
	const transientLayers = getTransientLayers();
	const editor = new PromptEditorDialogState();
	const refinement = new PromptRefinementController();
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let preview = $state(false);
	let destroyed = false;
	const canRefine = $derived(
		active &&
			draft.canEdit &&
			!refinement.pending &&
			normalizeRefinePromptRequest({
				draft: draft.field('description'),
				target: 'issue-description',
			}) !== null,
	);
	const layer = transientLayerAttachment({
		registry: transientLayers,
		id: allocateTransientLayerId('issue-description-refinement'),
		kind: 'prompt-transform',
		modality: 'nonmodal',
		onEscape: () => {
			cancel();
			return true;
		},
		restoreFocus: () => void focusEditor(),
	});
	function setText(value: string) {
		if (!refinement.pending) draft.setField('description', value);
	}
	function expand() {
		if (!textarea || !draft.canEdit || refinement.pending) return;
		editor.show(promptEditorSelectionFromTextarea(textarea));
	}
	async function closeEditor() {
		const selection = editor.selection;
		editor.close();
		await tick();
		if (destroyed || !active || !textarea) return;
		restorePromptEditorSelection(textarea, selection);
		textarea.focus({ preventScroll: true });
	}
	async function focusEditor(caret?: number) {
		if (destroyed || !active) return;
		if (editor.open) {
			if (caret === undefined) editor.requestFocus();
			else editor.moveCaretToEnd(caret);
			return;
		}
		await tick();
		if (destroyed || !active || !textarea) return;
		if (caret !== undefined) textarea.setSelectionRange(caret, caret);
		textarea.focus({ preventScroll: true });
	}
	function cancel() {
		refinement.cancel();
		onPendingChange(false);
		void focusEditor();
	}
	async function refine() {
		if (refinement.pending) {
			cancel();
			return;
		}
		if (!canRefine) return;
		const source = draft;
		const version = source.current.version;
		const text = source.field('description');
		onPendingChange(true);
		try {
			const result = await refinement.run({ draft: text, target: 'issue-description' });
			if (destroyed || !active || result.kind !== 'refined' || draft !== source || !source.canEdit)
				return;
			if (source.current.version !== version) {
				notifications.info(m.prompt_refinement_draft_changed());
				return;
			}
			const refined = result.response.refinedPrompt;
			source.setField('description', refined);
			notifications.info(
				refined === text ? m.prompt_refinement_unchanged() : m.prompt_refinement_refined(),
			);
			await focusEditor(refined.length);
		} catch (error) {
			if (!destroyed && active && draft === source && source.canEdit)
				notifications.error(promptRefinementErrorMessage(error));
		} finally {
			if (!destroyed) onPendingChange(refinement.pending);
		}
	}
	$effect(() => {
		if (active) return;
		refinement.cancel();
		editor.close();
		onPendingChange(false);
	});
	onDestroy(() => {
		destroyed = true;
		refinement.cancel();
		onPendingChange(false);
	});
</script>

<div class="issue-description-editor" {@attach refinement.pending && !editor.open && layer}>
	<div class="issue-actions">
		<label class="issue-field-label" for={id}>{m.issues_description()}</label>
		<button
			type="button"
			class="issue-text-button"
			aria-pressed={preview}
			disabled={refinement.pending}
			onclick={() => (preview = !preview)}
		>
			{preview ? m.issues_write() : m.issues_preview()}
		</button>
	</div>
	{#if preview}<IssueMarkdown text={draft.field('description')} />
	{:else}
		<PromptTextField
			{id}
			bind:ref={textarea}
			bind:value={() => draft.field('description'), setText}
			rows={6}
			{onkeydown}
			invalid={false}
			disabled={!draft.canEdit}
			readOnly={refinement.pending}
			canExpand={draft.canEdit}
			expandLabel={m.issues_description_expand()}
			canRefinePrompt={canRefine}
			isPromptRefinementPending={refinement.pending}
			onExpand={expand}
			onRefinePrompt={() => void refine()}
			dataAttributes={{
				'data-issue-focus': JSON.stringify({
					kind: 'draft',
					draftId: draft.current.id,
					field: 'description',
				}),
				'data-draft-version': draft.current.version,
			}}
		/>
	{/if}
</div>
{#if editor.open}
	<PromptEditorDialog
		title={m.issues_description()}
		editorLabel={m.issues_description()}
		text={draft.field('description')}
		selection={editor.selection}
		focusRequestId={editor.focusRequestId}
		readOnly={!draft.canEdit || refinement.pending}
		canRefinePrompt={canRefine}
		isPromptRefinementPending={refinement.pending}
		onTextChange={setText}
		onSelectionChange={(selection) => editor.updateSelection(selection)}
		onRefinePrompt={() => void refine()}
		onClose={() => void closeEditor()}
	/>
{/if}
