<script lang="ts">
	import { untrack } from 'svelte';
	import QueuedInputsDialog from '../QueuedInputsDialog.svelte';
	import { QueuedInputEditorState } from '$lib/chat/conversation/queued-input-editor-state.svelte';
	import type { ChatQueueState, QueueEntry } from '$lib/types/chat';
	import type { QueueEntryPlacement } from '$shared/chat-command-contracts';

	interface Props {
		initialQueue: ChatQueueState;
		onCreate: (content: string) => Promise<void>;
		onReplace: (entryId: string, content: string, expectedRevision: number) => Promise<void>;
		onDelete: (entryId: string) => Promise<void>;
		onMove: (
			source: QueueEntry,
			target: QueueEntry,
			placement: QueueEntryPlacement,
			reorderRevision: number,
		) => Promise<void>;
		onPause: () => Promise<void>;
		onResume: (pauseId: string) => Promise<void>;
	}

	let {
		initialQueue,
		onCreate,
		onReplace,
		onDelete,
		onMove,
		onPause,
		onResume,
	}: Props = $props();
	let open = $state(true);
	let queue = $state<ChatQueueState>(untrack(() => initialQueue));
	const editor = new QueuedInputEditorState({
		get queue() {
			return queue;
		},
	});

	export function setQueue(nextQueue: ChatQueueState): void {
		queue = nextQueue;
	}

	export function beginEdit(entry: QueueEntry): void {
		editor.begin(entry);
	}

	export function closeDialog(): void {
		open = false;
		editor.close();
	}

	export function openDialog(): void {
		open = true;
	}
</script>

{#if open}
	<QueuedInputsDialog
		open={true}
		{queue}
		{editor}
		{onCreate}
		{onReplace}
		{onDelete}
		{onMove}
		{onPause}
		{onResume}
		onClose={closeDialog}
	/>
{/if}
