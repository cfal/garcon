<script lang="ts">
	import { untrack } from 'svelte';
	import QueuedInputsDialog from '../QueuedInputsDialog.svelte';
	import { QueuedInputEditorState } from '$lib/chat/conversation/queued-input-editor-state.svelte';
	import type { QueueEntry, QueueState } from '$lib/types/chat';

	interface Props {
		initialQueue: QueueState;
		onCreate: (content: string) => Promise<void>;
		onReplace: (entryId: string, content: string, expectedRevision: number) => Promise<void>;
		onDelete: (entryId: string) => Promise<void>;
		onResume: () => Promise<void>;
	}

	let { initialQueue, onCreate, onReplace, onDelete, onResume }: Props = $props();
	let open = $state(true);
	let queue = $state<QueueState>(untrack(() => initialQueue));
	const editor = new QueuedInputEditorState({
		get queue() {
			return queue;
		},
	});

	export function setQueue(nextQueue: QueueState): void {
		queue = nextQueue;
	}

	export function beginEdit(entry: QueueEntry): void {
		editor.begin(entry);
	}
</script>

<QueuedInputsDialog
	{open}
	{queue}
	{editor}
	{onCreate}
	{onReplace}
	{onDelete}
	{onResume}
	onClose={() => {
		open = false;
		editor.close();
	}}
/>
