<script lang="ts">
	import type { QueueEntry, QueueState } from '$lib/types/chat';
	import * as m from '$lib/paraglide/messages.js';
	import {
		ChevronLeft,
		ChevronRight,
		ListTodo,
		Loader2,
		Pause,
		Pencil,
		Play,
		Square,
		Trash2,
	} from '@lucide/svelte';
	import { CHAT_DOCK_SURFACE_CLASS } from '$lib/chat/conversation/chat-max-width.js';
	import { cn } from '$lib/utils/cn';

	interface Props {
		chatId: string | null;
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
		chatId,
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

	interface QueuePreviewSelection {
		chatId: string;
		entryId: string;
	}

	let previewSelection = $state<QueuePreviewSelection | null>(null);
	const entries = $derived(queue?.entries ?? []);
	const queuedEntryCount = $derived(entries.length);
	const previewIndex = $derived.by(() => {
		if (entries.length === 0) return -1;
		if (!chatId || previewSelection?.chatId !== chatId) return 0;

		const retainedIndex = entries.findIndex((entry) => entry.id === previewSelection?.entryId);
		return retainedIndex >= 0 ? retainedIndex : 0;
	});
	const previewEntry = $derived(entries[previewIndex] ?? null);
	const canBrowsePrevious = $derived(previewIndex > 0);
	const canBrowseNext = $derived(previewIndex >= 0 && previewIndex < queuedEntryCount - 1);
	const showQueueManager = $derived(queuedEntryCount > 1);
	const showInterruptAction = $derived(
		previewIndex === 0 && !queue?.pause && canInterrupt && Boolean(onInterrupt),
	);
	let deletingEntryIds = $state<Set<string>>(new Set());
	let dispatchMutation = $state<'idle' | 'pausing' | 'resuming' | 'interrupting'>('idle');

	function selectPreview(index: number): void {
		if (!chatId) return;
		const entry = entries[index];
		if (!entry) return;
		previewSelection = { chatId, entryId: entry.id };
	}

	async function deleteEntry(entryId: string): Promise<void> {
		if (deletingEntryIds.has(entryId)) return;
		deletingEntryIds = new Set([...deletingEntryIds, entryId]);
		try {
			await onDelete(entryId);
		} finally {
			const nextDeletingEntryIds = new Set(deletingEntryIds);
			nextDeletingEntryIds.delete(entryId);
			deletingEntryIds = nextDeletingEntryIds;
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

{#if previewEntry}
	<section
		class={cn(CHAT_DOCK_SURFACE_CLASS, 'text-foreground')}
		aria-label={m.chat_queue_dialog_title()}
	>
		<div class="flex items-start gap-2 px-4 py-3">
			<div class="min-w-0 flex-1 border-l-2 border-queue-entry-border pl-3">
				<p
					data-queue-preview
					class="line-clamp-2 h-10 whitespace-pre-wrap break-words text-sm leading-5"
				>
					{previewEntry.content}
				</p>
			</div>
			<div class="flex shrink-0 items-center gap-0.5">
				<button
					type="button"
					onclick={() => onEdit(previewEntry)}
					disabled={deletingEntryIds.has(previewEntry.id)}
					class="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
					title={m.chat_queue_edit_message()}
					aria-label={m.chat_queue_edit_message()}
				>
					<Pencil class="h-4 w-4" />
				</button>
				<button
					type="button"
					onclick={() => void deleteEntry(previewEntry.id)}
					disabled={deletingEntryIds.has(previewEntry.id)}
					class="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
					title={m.chat_queue_remove_from_queue()}
					aria-label={m.chat_queue_remove_from_queue()}
				>
					{#if deletingEntryIds.has(previewEntry.id)}
						<Loader2 class="h-4 w-4 animate-spin" />
					{:else}
						<Trash2 class="h-4 w-4" />
					{/if}
				</button>
			</div>
		</div>

		<footer
			class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-3 py-2"
		>
			<div class="flex min-w-0 flex-wrap items-center gap-2">
				{#if showQueueManager}
					<div
						role="group"
						aria-label={m.chat_queue_browse_messages()}
						class="flex shrink-0 items-center"
					>
						<button
							type="button"
							onclick={() => selectPreview(previewIndex - 1)}
							disabled={!canBrowsePrevious || dispatchMutation === 'interrupting'}
							class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
							title={m.chat_queue_previous_message()}
							aria-label={m.chat_queue_previous_message()}
						>
							<ChevronLeft class="h-4 w-4" />
						</button>
						<span
							class="min-w-[4.5rem] text-center text-xs tabular-nums text-muted-foreground"
							aria-live="polite"
							aria-atomic="true"
						>
							{m.chat_queue_message_position({
								current: previewIndex + 1,
								total: queuedEntryCount,
							})}
						</span>
						<button
							type="button"
							onclick={() => selectPreview(previewIndex + 1)}
							disabled={!canBrowseNext || dispatchMutation === 'interrupting'}
							class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
							title={m.chat_queue_next_message()}
							aria-label={m.chat_queue_next_message()}
						>
							<ChevronRight class="h-4 w-4" />
						</button>
					</div>
				{:else}
					<span class="text-xs text-muted-foreground">{m.chat_queue_single_message()}</span>
				{/if}

				{#if queue?.pause}
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

			<div class="ml-auto flex flex-wrap items-center justify-end gap-1">
				{#if showInterruptAction && onInterrupt}
					<button
						type="button"
						onclick={() => void mutateDispatch('interrupting', onInterrupt)}
						disabled={dispatchMutation !== 'idle'}
						class="flex min-h-8 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
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

				{#if showQueueManager}
					<button
						type="button"
						onclick={onOpenManager}
						class="flex min-h-8 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<ListTodo class="h-4 w-4" />
						<span>{m.chat_queue_edit_queue()}</span>
					</button>
				{/if}

				{#if queue?.pause}
					<button
						type="button"
						onclick={() => void mutateDispatch('resuming', () => onResume(queue.pause!.id))}
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
				{/if}
			</div>
		</footer>
	</section>
{/if}
