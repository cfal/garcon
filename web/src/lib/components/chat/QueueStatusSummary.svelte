<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ChatQueueState, QueueEntry } from '$lib/types/chat';
	import { CHAT_DOCK_SURFACE_CLASS } from '$lib/chat/conversation/chat-max-width.js';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		queue: ChatQueueState;
		entry: QueueEntry;
		position: number;
		entryActions?: Snippet;
		navigation?: Snippet;
		actions?: Snippet;
	}

	let { queue, entry, position, entryActions, navigation, actions }: Props = $props();

	const entryCount = $derived(queue.entries.length);
	const currentPosition = $derived(Math.min(Math.max(position, 1), entryCount));
</script>

<section
	class={cn(CHAT_DOCK_SURFACE_CLASS, 'text-foreground')}
	aria-label={m.chat_queue_dialog_title()}
	data-queue-status-summary
>
	<div class="flex items-start gap-2 px-4 py-3">
		<div class="min-w-0 flex-1 border-l-2 border-queue-entry-border pl-3">
			<p data-queue-preview class="line-clamp-2 h-10 whitespace-pre-wrap break-words text-sm leading-5">
				{entry.content}
			</p>
		</div>
		{#if entryActions}
			{@render entryActions()}
		{/if}
	</div>

	<footer class="flex items-center gap-3 border-t border-border px-3 py-2">
		<div class="flex min-w-0 flex-wrap items-center gap-2">
			{#if navigation}
				{@render navigation()}
			{:else if entryCount > 1}
				<span class="text-xs tabular-nums text-muted-foreground">
					{m.chat_queue_message_position({ current: currentPosition, total: entryCount })}
				</span>
			{:else}
				<span class="text-xs text-muted-foreground">{m.chat_queue_single_message()}</span>
			{/if}

			{#if queue.pause}
				{#if queue.pause.kind === 'manual'}
					<span class="text-xs font-medium text-queue-foreground">
						{m.chat_queue_paused()}
					</span>
				{:else}
					<span class="text-xs font-medium text-status-warning-muted-foreground">
						{m.chat_queue_needs_attention()}
					</span>
				{/if}
			{/if}
		</div>

		{#if actions}
			{@render actions()}
		{/if}
	</footer>
</section>
