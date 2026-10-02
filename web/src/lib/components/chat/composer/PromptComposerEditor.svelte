<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import PromptEditorDialog from '$lib/components/prompt-editor/PromptEditorDialog.svelte';
	import {
		getChatSessions,
		getComposerState,
		getLocalSettings,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import ComposerAttachmentBadge from './ComposerAttachmentBadge.svelte';
	import { PromptComposerEditorController } from './prompt-composer-editor-controller.js';
	import type { PromptComposerUiState } from './prompt-composer-state.svelte.js';

	interface Props {
		ui: PromptComposerUiState;
		textarea: HTMLTextAreaElement | undefined;
		isVisible: boolean;
		isPresented: boolean;
		isDisabled: boolean;
		promptTransformPending: boolean;
		isPromptRefinementPending: boolean;
		canRefinePrompt: boolean;
		openRequestId: number;
		onRefinePrompt: () => void;
		resizeTextarea: () => void;
	}

	let {
		ui,
		textarea,
		isVisible,
		isPresented,
		isDisabled,
		promptTransformPending,
		isPromptRefinementPending,
		canRefinePrompt,
		openRequestId,
		onRefinePrompt,
		resizeTextarea,
	}: Props = $props();
	const composer = getComposerState();
	const sessions = getChatSessions();
	const localSettings = getLocalSettings();
	const workspace = getWorkspaceCoordinator();
	const chatSurfaceId = $derived(workspace.composerAnchorSurfaceId);
	const controller = new PromptComposerEditorController({
		get ui() {
			return ui;
		},
		composer,
		get selectedChatId() {
			return sessions.selectedChatId;
		},
		get textarea() {
			return textarea;
		},
		get isVisible() {
			return isVisible;
		},
		get isDisabled() {
			return isDisabled;
		},
		get promptTransformPending() {
			return promptTransformPending;
		},
		get snippetTrigger() {
			return localSettings.snippetTrigger;
		},
		get resizeTextarea() {
			return resizeTextarea;
		},
	});

	onDestroy(() => controller.destroy());

	export function open(): boolean {
		return controller.open();
	}

	$effect(() => {
		const requestId = openRequestId;
		const selectedChatId = sessions.selectedChatId;
		const hasPresentedEditor = isPresented && ui.composerEditorOpen;
		if (
			!selectedChatId ||
			(!hasPresentedEditor && (!isVisible || isDisabled || promptTransformPending))
		) {
			return;
		}
		untrack(() => controller.handleOpenRequest(requestId));
	});

	$effect(() => {
		if (isPresented || !ui.composerEditorOpen) return;
		untrack(() => controller.close(false));
	});
</script>

{#if ui.composerEditorOpen && ui.composerEditorChatId}
	{@const editorChatId = ui.composerEditorChatId}
	{#snippet expandedEditorHeaderStatus()}
		<ComposerAttachmentBadge count={composer.images.length} />
	{/snippet}
	<PromptEditorDialog
		title={m.chat_composer_expanded_editor_title()}
		editorLabel={m.chat_composer_expanded_editor_label()}
		text={composer.inputText}
		selection={ui.composerEditorSelection}
		focusRequestId={ui.composerEditorFocusRequestId}
		readOnly={promptTransformPending}
		surfaceId={chatSurfaceId ?? undefined}
		headerStatus={expandedEditorHeaderStatus}
		{canRefinePrompt}
		{isPromptRefinementPending}
		onTextChange={(text) => controller.updateText(editorChatId, text)}
		onSelectionChange={(selection) => controller.updateSelection(editorChatId, selection)}
		{onRefinePrompt}
		onClose={() => controller.close()}
	/>
{/if}
