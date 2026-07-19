<script lang="ts">
	import { untrack } from 'svelte';
	import QueuedInputsDialog from '../QueuedInputsDialog.svelte';
	import { QueuedInputEditorState } from '$lib/chat/conversation/queued-input-editor-state.svelte';
	import type { ChatQueueState, QueueEntry, RecoveredInputContinuation } from '$lib/types/chat';

	interface Props {
		initialQueue: ChatQueueState;
		initialContinuation: RecoveredInputContinuation | null;
		onCreate: (content: string) => Promise<void>;
		onReplace: (entryId: string, content: string, expectedRevision: number) => Promise<void>;
		onDelete: (entryId: string) => Promise<void>;
		onPause: () => Promise<void>;
		onResume: (pauseId: string) => Promise<void>;
		onContinue: (continuationId: string) => Promise<void>;
	}

	let {
		initialQueue,
		initialContinuation,
		onCreate,
		onReplace,
		onDelete,
		onPause,
		onResume,
		onContinue,
	}: Props = $props();
	let open = $state(true);
	let queue = $state<ChatQueueState>(untrack(() => initialQueue));
	let continuation = $state<RecoveredInputContinuation | null>(untrack(() => initialContinuation));
	const editor = new QueuedInputEditorState({
		get queue() {
			return queue;
		},
	});

	export function setQueue(nextQueue: ChatQueueState): void {
		queue = nextQueue;
	}

	export function setContinuation(nextContinuation: RecoveredInputContinuation | null): void {
		continuation = nextContinuation;
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
		{continuation}
		{editor}
		{onCreate}
		{onReplace}
		{onDelete}
		{onPause}
		{onResume}
		{onContinue}
		onClose={closeDialog}
	/>
{/if}
