<script lang="ts">
	import type { QueueState } from '$lib/types/chat';
	import * as m from '$lib/paraglide/messages.js';
	import { SendHorizontal, Square, X } from '@lucide/svelte';
	import { cn } from '$lib/utils/cn';

	interface Props {
		queue: QueueState | null;
		canInterrupt?: boolean;
		onInterrupt?: () => void;
		onResume?: () => void;
		onDequeue: (entryId: string) => void;
	}

	let {
		queue,
		canInterrupt = false,
		onInterrupt,
		onResume,
		onDequeue,
	}: Props = $props();

	const VISIBLE_ENTRY_LIMIT = 3;
	const PREVIEW_CHAR_LIMIT = 180;

	// Only queued entries belong in this panel. Once an entry is 'sending' it has
	// been dispatched into the transcript as a pending user message, so showing it
	// here too would duplicate it and leave a stale row while the badge reads zero.
	const queuedEntries = $derived(
		(queue?.entries ?? []).filter((entry) => entry.status === 'queued'),
	);
	const queuedEntryCount = $derived(queuedEntries.length);
	const visibleEntries = $derived(queuedEntries.slice(0, VISIBLE_ENTRY_LIMIT));
	const hiddenEntryCount = $derived(Math.max(0, queuedEntries.length - visibleEntries.length));
	const hasEntries = $derived(queuedEntries.length > 0);
	const visible = $derived(hasEntries);

	function previewContent(content: string): string {
		if (content.length <= PREVIEW_CHAR_LIMIT) return content;
		return `${content.slice(0, PREVIEW_CHAR_LIMIT).trimEnd()}...`;
	}
</script>

{#if visible}
	<div class="border-b border-queue-border bg-queue-surface px-3 py-2">
		<div class="mb-1.5 flex items-center justify-between gap-3 text-xs text-queue-foreground">
			<div class="flex min-w-0 items-center gap-2">
				<span class="font-medium">{m.chat_queue_pending_inputs()}</span>
				<span class="rounded bg-queue-action-bg px-1.5 py-0.5 tabular-nums">
					{m.chat_queue_pending_count({ count: queuedEntryCount })}
				</span>
			</div>

			{#if queue?.paused}
				<span class="shrink-0 font-medium">{m.chat_queue_paused()}</span>
			{/if}
		</div>

		<div class="space-y-1">
			{#each visibleEntries as entry (entry.id)}
				<div class="flex items-start gap-2 border-l-2 border-queue-entry-border pl-2">
					<div class="min-w-0 flex-1">
						<span
							class={cn(
								'block text-sm leading-5 text-queue-foreground whitespace-pre-wrap break-words',
								entry.content.length > PREVIEW_CHAR_LIMIT && 'max-h-[4.75rem] overflow-hidden',
							)}
						>
							{previewContent(entry.content)}
						</span>
					</div>
					<button
						type="button"
						onclick={() => onDequeue(entry.id)}
						class="shrink-0 rounded p-1 text-queue-foreground hover:bg-queue-action-hover-bg focus-visible:ring-2 focus-visible:ring-ring"
						title={m.chat_queue_remove_from_queue()}
						aria-label={m.chat_queue_remove_from_queue()}
					>
						<X class="h-3.5 w-3.5" />
					</button>
				</div>
			{/each}
		</div>

		{#if hiddenEntryCount > 0}
			<div class="mt-1 pl-3 text-xs text-queue-foreground/75">
				{m.chat_queue_more_pending({ count: hiddenEntryCount })}
			</div>
		{/if}

		<div class="mt-2 flex items-center gap-2">
			{#if queue?.paused && onResume}
				<button
					type="button"
					onclick={onResume}
					class="flex items-center gap-1.5 rounded bg-queue-action-bg px-2.5 py-1 text-sm font-medium text-queue-foreground hover:bg-queue-action-hover-bg focus-visible:ring-2 focus-visible:ring-ring"
					title={m.chat_queue_send_now_queue()}
				>
					<SendHorizontal class="h-3.5 w-3.5" />
					{m.chat_queue_send_now()}
				</button>
			{:else if canInterrupt && onInterrupt}
				<button
					type="button"
					onclick={onInterrupt}
					class="flex items-center gap-1.5 rounded bg-queue-action-bg px-2.5 py-1 text-sm font-medium text-queue-foreground hover:bg-queue-action-hover-bg focus-visible:ring-2 focus-visible:ring-ring"
					title={m.chat_queue_interrupt_and_send_queue()}
				>
					<Square class="h-3.5 w-3.5" />
					{m.chat_queue_interrupt_and_send()}
				</button>
			{/if}
		</div>
	</div>
{/if}
