<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import PromptEditorDialog from '$lib/components/prompt-editor/PromptEditorDialog.svelte';
	import type { QueuedInputEditorState } from '$lib/chat/conversation/queued-input-editor-state.svelte.js';
	import { PromptEditorDialogState } from '$lib/prompt-editor/prompt-editor-dialog-state.svelte.js';
	import {
		promptEditorSelectionFromTextarea,
		restorePromptEditorSelection,
	} from '$lib/prompt-editor/prompt-editor-selection.js';
	import { getNotifications, getTransientLayers } from '$lib/context';
	import QueuedInputEditorPanel from './QueuedInputEditorPanel.svelte';
	import { QueuedInputRefinementController } from './queued-input-refinement-controller.js';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		chatId: string;
		executionKey?: string;
		editor: QueuedInputEditorState;
		onClose: () => void;
		onFocusComposer: (chatId: string) => void;
		onCreate: (content: string) => Promise<void>;
		onReplace: (entryId: string, content: string, expectedRevision: number) => Promise<void>;
	}
	let {
		chatId,
		executionKey = '',
		editor,
		onClose,
		onFocusComposer,
		onCreate,
		onReplace,
	}: Props = $props();
	const notifications = getNotifications();
	const transientLayers = getTransientLayers();
	const expandedEditor = new PromptEditorDialogState();
	const editTrigger = untrack(() =>
		document.activeElement instanceof HTMLElement ? document.activeElement : null,
	);
	const queueSurface = editTrigger?.closest<HTMLElement>('[data-queue-status-summary]');
	const originChatId = untrack(() => chatId);
	let editorTextarea = $state<HTMLTextAreaElement | null>(null);
	const refinement = new QueuedInputRefinementController({
		get chatId() {
			return chatId;
		},
		get executionKey() {
			return executionKey;
		},
		get editor() {
			return editor;
		},
		expandedEditor,
		notifications,
		transientLayers,
		get textarea() {
			return editorTextarea;
		},
		get startBlocked() {
			return editor.phase === 'closed';
		},
	});
	const refinementPending = $derived(refinement.pending);
	$effect(() => {
		executionKey;
		return () => refinement.abort();
	});

	onDestroy(() => {
		refinement.destroy();
		expandedEditor.close();
	});

	function close(): void {
		refinement.abort();
		expandedEditor.close();
		onClose();
	}

	function restoreChatFocus(event: Event): void {
		event.preventDefault();
		// Defers focus until the dialog releases the workspace's inert state.
		void tick().then(() => {
			if (queueSurface && queueSurface.dataset.queueChatId !== originChatId) return;
			const target =
				editTrigger?.isConnected && !editTrigger.matches(':disabled') ? editTrigger : queueSurface;
			if (target?.isConnected) target.focus({ preventScroll: true });
			else onFocusComposer(originChatId);
		});
	}

	function openExpandedEditor(): void {
		if (editor.mutation !== 'idle' || refinementPending || !editorTextarea) return;
		const selection = promptEditorSelectionFromTextarea(editorTextarea);
		editorTextarea.focus({ preventScroll: true });
		expandedEditor.show(selection);
	}

	async function closeExpandedEditor(): Promise<void> {
		const selection = expandedEditor.selection;
		expandedEditor.close();
		await tick();
		if (!editorTextarea) return;
		restorePromptEditorSelection(editorTextarea, selection);
		editorTextarea.focus({ preventScroll: true });
	}

	function handleExpandedTextChange(text: string): void {
		if (refinementPending || editor.mutationBlocked || editor.draft === text) return;
		editor.draft = text;
	}
</script>

<Dialog.Root
	open={true}
	onOpenChange={(open) => {
		if (!open) close();
	}}
>
	<Dialog.Content
		class="inset-y-0 right-0 left-auto flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 sm:max-w-lg sm:border-l"
		showCloseButton={false}
		onCloseAutoFocus={restoreChatFocus}
	>
		<Dialog.Header class="shrink-0 border-b border-border px-5 py-4">
			<Dialog.Title>{m.chat_queue_edit_message()}</Dialog.Title>
			<Dialog.Description>{m.chat_queue_editor_description()}</Dialog.Description>
		</Dialog.Header>
		<div
			class="min-h-0 flex-1 overflow-y-auto p-5"
			{@attach refinementPending && !expandedEditor.open && refinement.layerAttachment}
		>
			<QueuedInputEditorPanel
				{editor}
				bind:textarea={editorTextarea}
				canRefinePrompt={refinement.canStart}
				isPromptRefinementPending={refinementPending}
				{onCreate}
				{onReplace}
				onExpand={openExpandedEditor}
				onRefinePrompt={() => refinement.handleAction()}
				onClose={close}
			/>
		</div>
	</Dialog.Content>
</Dialog.Root>

{#if expandedEditor.open}
	<PromptEditorDialog
		title={m.chat_queue_expanded_editor_title()}
		editorLabel={m.chat_queue_expanded_editor_label()}
		text={editor.draft}
		selection={expandedEditor.selection}
		focusRequestId={expandedEditor.focusRequestId}
		readOnly={refinementPending || editor.mutationBlocked || editor.mutation !== 'idle'}
		canRefinePrompt={refinement.canStart}
		isPromptRefinementPending={refinementPending}
		onTextChange={handleExpandedTextChange}
		onSelectionChange={(selection) => expandedEditor.updateSelection(selection)}
		onRefinePrompt={() => refinement.handleAction()}
		onClose={() => void closeExpandedEditor()}
	/>
{/if}
