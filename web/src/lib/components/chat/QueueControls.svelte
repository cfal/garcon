<script lang="ts">
	import type { QueueEntry, QueueState } from '$lib/types/chat';
	import * as m from '$lib/paraglide/messages.js';
	import { ListTodo, Loader2, Pause, Pencil, Play, Square, Trash2 } from '@lucide/svelte';
	import { CHAT_DOCK_SURFACE_CLASS } from '$lib/chat/conversation/chat-max-width.js';
	import { cn } from '$lib/utils/cn';

	interface Props {
		queue: QueueState | null;
		canInterrupt?: boolean;
		onInterrupt?: () => void | Promise<void>;
		onPause: () => Promise<void>;
		onResume: (pauseId: string) => Promise<void>;
		onQueueControlError: (action: 'pause' | 'resume', error: unknown) => void;
		onEdit: (entry: QueueEntry) => void;
		onOpenManager: () => void;
		onDelete: (entryId: string) => Promise<void>;
	}

	let {
		queue,
		canInterrupt = false,
		onInterrupt,
		onPause,
		onResume,
		onQueueControlError,
		onEdit,
		onOpenManager,
		onDelete,
	}: Props = $props();

	const PREVIEW_CHAR_LIMIT = 220;
	const queuedEntryCount = $derived(queue?.entries.length ?? 0);
	const firstEntry = $derived(queue?.entries[0] ?? null);
	const showQueueManager = $derived(queuedEntryCount > 1);
	const showDispatchAction = $derived(
		Boolean(firstEntry),
	);
	let deletingEntryId = $state<string | null>(null);
	let dispatchMutation = $state<'idle' | 'pausing' | 'resuming' | 'interrupting'>('idle');

	function previewContent(content: string): string {
		if (content.length <= PREVIEW_CHAR_LIMIT) return content;
		return `${content.slice(0, PREVIEW_CHAR_LIMIT).trimEnd()}...`;
	}

	async function deleteEntry(entryId: string): Promise<void> {
		if (deletingEntryId === entryId) return;
		deletingEntryId = entryId;
		try {
			await onDelete(entryId);
		} finally {
			if (deletingEntryId === entryId) deletingEntryId = null;
		}
	}

	async function mutateDispatch(
		mutation: Exclude<typeof dispatchMutation, 'idle'>,
		action: () => void | Promise<void>,
	): Promise<void> {
		if (dispatchMutation !== 'idle') return;
		dispatchMutation = mutation;
		try {
			await action();
		} catch (error) {
			if (mutation === 'pausing' || mutation === 'resuming') {
				onQueueControlError(mutation === 'pausing' ? 'pause' : 'resume', error);
			}
		} finally {
			if (dispatchMutation === mutation) dispatchMutation = 'idle';
		}
	}
</script>

{#if firstEntry}
	<section
		class={cn(CHAT_DOCK_SURFACE_CLASS, 'text-foreground')}
		aria-label={m.chat_queue_queued_input()}
	>
		<header class="flex items-center justify-between gap-3 px-4 pt-3 text-xs">
			<span class="font-medium text-muted-foreground">{m.chat_queue_queued_input()}</span>
			{#if queue?.pause}
				{#if queue.pause.kind === 'manual'}
					<span class="font-medium text-queue-foreground">{m.chat_queue_paused()}</span>
				{:else}
					<span class="font-medium text-status-warning-muted-foreground">
						{m.chat_queue_needs_attention()}
					</span>
				{/if}
			{/if}
		</header>

		<div class="flex items-start gap-2 px-4 pb-3 pt-2">
			<div class="min-w-0 flex-1 border-l-2 border-queue-entry-border pl-3">
				<p
					class="max-h-[3.75rem] overflow-hidden whitespace-pre-wrap break-words text-sm leading-5"
				>
					{previewContent(firstEntry.content)}
				</p>
			</div>
			<div class="flex shrink-0 items-center gap-0.5">
				<button
					type="button"
					onclick={() => onEdit(firstEntry)}
					disabled={deletingEntryId === firstEntry.id}
					class="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
					title={m.chat_queue_edit_message()}
					aria-label={m.chat_queue_edit_message()}
				>
					<Pencil class="h-4 w-4" />
				</button>
				<button
					type="button"
					onclick={() => void deleteEntry(firstEntry.id)}
					disabled={deletingEntryId === firstEntry.id}
					class="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
					title={m.chat_queue_remove_from_queue()}
					aria-label={m.chat_queue_remove_from_queue()}
				>
					{#if deletingEntryId === firstEntry.id}
						<Loader2 class="h-4 w-4 animate-spin" />
					{:else}
						<Trash2 class="h-4 w-4" />
					{/if}
				</button>
			</div>
		</div>

		{#if showQueueManager || showDispatchAction}
			<footer class="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
				{#if showQueueManager}
					<button
						type="button"
						onclick={onOpenManager}
						class="flex min-h-8 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<ListTodo class="h-4 w-4" />
						<span>{m.chat_queue_edit_queued_messages({ count: queuedEntryCount })}</span>
					</button>
				{/if}

				{#if queue?.pause}
					<button
						type="button"
						onclick={() =>
							void mutateDispatch('resuming', () => onResume(queue.pause!.id))}
						disabled={dispatchMutation !== 'idle'}
						class="flex min-h-8 items-center gap-2 rounded-lg bg-queue-action-bg px-2.5 text-sm font-medium text-queue-foreground transition-colors hover:bg-queue-action-hover-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						title={m.chat_queue_resume_queue()}
					>
						{#if dispatchMutation === 'resuming'}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<Play class="h-4 w-4" />
						{/if}
						{m.chat_queue_resume()}
					</button>
				{:else}
					<button
						type="button"
						onclick={() => void mutateDispatch('pausing', onPause)}
						disabled={dispatchMutation !== 'idle'}
						class="flex min-h-8 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
						title={m.chat_queue_pause_queue()}
					>
						{#if dispatchMutation === 'pausing'}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<Pause class="h-4 w-4" />
						{/if}
						{m.chat_queue_pause()}
					</button>
					{#if canInterrupt && onInterrupt}
					<button
						type="button"
						onclick={() => void mutateDispatch('interrupting', onInterrupt)}
						disabled={dispatchMutation !== 'idle'}
						class="flex min-h-8 items-center gap-2 rounded-lg bg-queue-action-bg px-2.5 text-sm font-medium text-queue-foreground transition-colors hover:bg-queue-action-hover-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						title={m.chat_queue_interrupt_and_send_queue()}
					>
						{#if dispatchMutation === 'interrupting'}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<Square class="h-4 w-4" />
						{/if}
						{m.chat_queue_interrupt_and_send()}
					</button>
					{/if}
				{/if}
			</footer>
		{/if}
	</section>
{/if}
