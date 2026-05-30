<script lang="ts">
	import type { QueueState } from '$lib/types/chat';
	import * as m from '$lib/paraglide/messages.js';
	import { X, Play, Pause } from '@lucide/svelte';
	import { cn } from '$lib/utils/cn';

	interface Props {
		queue: QueueState | null;
		onResume: () => void;
		onPause?: () => void;
		onDequeue: (entryId: string) => void;
	}

	let { queue, onResume, onPause, onDequeue }: Props = $props();

	const VISIBLE_ENTRY_LIMIT = 3;
	const PREVIEW_CHAR_LIMIT = 180;

	const queueEntries = $derived(queue?.entries ?? []);
	const queuedEntryCount = $derived(queueEntries.filter((entry) => entry.status === 'queued').length);
	const visibleEntries = $derived(queueEntries.slice(0, VISIBLE_ENTRY_LIMIT));
	const hiddenEntryCount = $derived(Math.max(0, queueEntries.length - visibleEntries.length));
	const hasEntries = $derived(queueEntries.length > 0);
	const visible = $derived(hasEntries);

	function previewContent(content: string): string {
		if (content.length <= PREVIEW_CHAR_LIMIT) return content;
		return `${content.slice(0, PREVIEW_CHAR_LIMIT).trimEnd()}...`;
	}

	function entryStatusLabel(status: 'queued' | 'sending'): string {
		return status === 'sending' ? m.chat_queue_sending() : m.chat_queue_pending_inputs();
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
						<div class="mb-0.5 text-[11px] font-medium uppercase tracking-normal text-queue-foreground/75">
							{entryStatusLabel(entry.status)}
						</div>
						<span class={cn(
							'block text-sm leading-5 text-queue-foreground whitespace-pre-wrap break-words',
							entry.content.length > PREVIEW_CHAR_LIMIT && 'max-h-[4.75rem] overflow-hidden'
						)}>
							{previewContent(entry.content)}
						</span>
					</div>
					{#if entry.status === 'queued'}
						<button
							type="button"
							onclick={() => onDequeue(entry.id)}
							class="shrink-0 rounded p-1 text-queue-foreground hover:bg-queue-action-hover-bg focus-visible:ring-2 focus-visible:ring-ring"
							title={m.chat_queue_remove_from_queue()}
							aria-label={m.chat_queue_remove_from_queue()}
						>
							<X class="h-3.5 w-3.5" />
						</button>
					{/if}
				</div>
			{/each}
		</div>

		{#if hiddenEntryCount > 0}
			<div class="mt-1 pl-3 text-xs text-queue-foreground/75">
				{m.chat_queue_more_pending({ count: hiddenEntryCount })}
			</div>
		{/if}

		<div class="mt-2 flex items-center gap-2">
			{#if queue?.paused}
				<button
					type="button"
					onclick={onResume}
					class="flex items-center gap-1.5 rounded bg-queue-action-bg px-2.5 py-1 text-sm font-medium text-queue-foreground hover:bg-queue-action-hover-bg focus-visible:ring-2 focus-visible:ring-ring"
					title={m.chat_queue_resume_queue()}
				>
					<Play class="h-3.5 w-3.5" />
					{m.chat_queue_resume()}
				</button>
			{:else if hasEntries && onPause}
				<button
					type="button"
					onclick={onPause}
					class="flex items-center gap-1.5 rounded bg-queue-action-bg px-2.5 py-1 text-sm font-medium text-queue-foreground hover:bg-queue-action-hover-bg focus-visible:ring-2 focus-visible:ring-ring"
					title={m.chat_queue_pause_queue()}
				>
					<Pause class="h-3.5 w-3.5" />
					{m.chat_queue_pause()}
				</button>
			{/if}
		</div>
	</div>
{/if}
