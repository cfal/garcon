<script lang="ts">
	import { untrack } from 'svelte';
	import ComposerEditorDialog from './ComposerEditorDialog.svelte';
	import { getChatSessions, getComposerState, getLocalSettings } from '$lib/context';
	import { PromptComposerEditorController } from './prompt-composer-editor-controller.js';
	import type { PromptComposerUiState } from './prompt-composer-state.svelte.js';

	interface Props {
		ui: PromptComposerUiState;
		textarea: HTMLTextAreaElement | undefined;
		isVisible: boolean;
		isPresented: boolean;
		isDisabled: boolean;
		promptTransformPending: boolean;
		openRequestId: number;
		resizeTextarea: () => void;
	}

	let {
		ui,
		textarea,
		isVisible,
		isPresented,
		isDisabled,
		promptTransformPending,
		openRequestId,
		resizeTextarea,
	}: Props = $props();
	const composer = getComposerState();
	const sessions = getChatSessions();
	const localSettings = getLocalSettings();
	const controller = new PromptComposerEditorController({
		ui,
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
		resizeTextarea,
	});

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
	<ComposerEditorDialog
		text={composer.inputText}
		selection={ui.composerEditorSelection}
		attachmentCount={composer.images.length}
		focusRequestId={ui.composerEditorFocusRequestId}
		onTextChange={(text) => controller.updateText(editorChatId, text)}
		onSelectionChange={(selection) => controller.updateSelection(editorChatId, selection)}
		onClose={() => controller.close()}
	/>
{/if}
