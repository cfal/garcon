<script lang="ts">
	import type { QueueState } from '$lib/types/chat';
	import * as m from '$lib/paraglide/messages.js';
	import { X, Play, Pause } from '@lucide/svelte';

	interface Props {
		queue: QueueState | null;
		onResume: () => void;
		onPause?: () => void;
		onDequeue: (entryId: string) => void;
	}

	let { queue, onResume, onPause, onDequeue }: Props = $props();

	const pendingEntries = $derived(
		queue?.entries.filter((e) => e.status === 'queued') ?? []
	);

	const hasEntries = $derived(pendingEntries.length > 0);
	const visible = $derived(hasEntries);
</script>

{#if visible}
	<div class="px-3 py-2 bg-queue-surface border-b border-queue-border">
		<div class="space-y-1.5">
			{#each pendingEntries as entry (entry.id)}
				<div class="flex items-center gap-2 pl-2 border-l-2 border-queue-entry-border">
					<span class="flex-1 text-sm text-queue-foreground whitespace-pre-wrap break-words">
						{entry.content}
					</span>
					<button
						type="button"
						onclick={() => onDequeue(entry.id)}
						class="flex-shrink-0 p-1 rounded hover:bg-queue-action-hover-bg transition-colors"
						title={m.chat_queue_remove_from_queue()}
					>
						<X class="w-3.5 h-3.5 text-queue-foreground" />
					</button>
				</div>
			{/each}
		</div>

		{#if queue?.paused}
			<span class="mt-1 block text-sm text-queue-foreground">{m.chat_queue_paused()}</span>
		{/if}

		{#if queue?.paused}
			<button
				type="button"
				onclick={onResume}
				class="mt-1.5 flex items-center gap-1.5 px-2.5 py-1 rounded text-sm font-medium text-queue-foreground bg-queue-action-bg hover:bg-queue-action-hover-bg transition-colors"
				title={m.chat_queue_resume_queue()}
			>
				<Play class="w-3.5 h-3.5" />
				{m.chat_queue_resume()}
			</button>
		{:else if hasEntries && onPause}
			<button
				type="button"
				onclick={onPause}
				class="mt-1.5 flex items-center gap-1.5 px-2.5 py-1 rounded text-sm font-medium text-queue-foreground bg-queue-action-bg hover:bg-queue-action-hover-bg transition-colors"
				title={m.chat_queue_pause_queue()}
			>
				<Pause class="w-3.5 h-3.5" />
				{m.chat_queue_pause()}
			</button>
		{/if}
	</div>
{/if}
