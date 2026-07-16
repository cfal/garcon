<script lang="ts">
	import type { QueueEntry } from '$lib/types/chat';
	import * as m from '$lib/paraglide/messages.js';
	import { Loader2, Pencil, Trash2 } from '@lucide/svelte';

	interface Props {
		entry: QueueEntry;
		position: number;
		error?: string;
		deleting: boolean;
		editDisabled: boolean;
		deleteDisabled: boolean;
		onEdit: (entry: QueueEntry) => void;
		onDelete: (entryId: string) => void;
	}

	let { entry, position, error, deleting, editDisabled, deleteDisabled, onEdit, onDelete }: Props =
		$props();
</script>

<div class="flex items-start gap-3 px-5 py-4 sm:px-6">
	<span class="mt-0.5 w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
		{position}
	</span>
	<div class="min-w-0 flex-1">
		<p class="whitespace-pre-wrap break-words text-sm leading-5">{entry.content}</p>
		{#if error}
			<p class="mt-2 text-xs text-destructive" role="alert">{error}</p>
		{/if}
	</div>
	<div class="flex shrink-0 items-center gap-0.5">
		<button
			type="button"
			data-queue-edit-id={entry.id}
			onclick={() => onEdit(entry)}
			disabled={editDisabled}
			class="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
			title={m.chat_queue_edit_message()}
			aria-label={m.chat_queue_edit_message()}
		>
			<Pencil class="h-4 w-4" />
		</button>
		<button
			type="button"
			onclick={() => onDelete(entry.id)}
			disabled={deleteDisabled}
			class="rounded-lg p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
			title={m.chat_queue_remove_from_queue()}
			aria-label={m.chat_queue_remove_from_queue()}
		>
			{#if deleting}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<Trash2 class="h-4 w-4" />
			{/if}
		</button>
	</div>
</div>
