<script lang="ts">
	import type { ChatQueueState, QueueEntry } from '$lib/types/chat';
	import * as m from '$lib/paraglide/messages.js';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FastForward from '@lucide/svelte/icons/fast-forward';
	import ListTodo from '@lucide/svelte/icons/list-todo';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Pause from '@lucide/svelte/icons/pause';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Play from '@lucide/svelte/icons/play';
	import Route from '@lucide/svelte/icons/route';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import ResponsiveSurfaceActions, {
		type ResponsiveSurfaceAction,
	} from '$lib/components/shared/ResponsiveSurfaceActions.svelte';
	import { CHAT_DOCK_SURFACE_CLASS } from '$lib/chat/conversation/chat-max-width.js';
	import { cn } from '$lib/utils/cn';

	interface Props {
		chatId: string | null;
		queue: ChatQueueState | null;
		canInterrupt?: boolean;
		canSteer?: boolean;
		onInterrupt?: () => void | Promise<void>;
		onSteer?: (entry: QueueEntry, expectedReorderRevision: number) => void | Promise<void>;
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
		canSteer = false,
		onInterrupt,
		onSteer,
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
	type DispatchMutationKind = 'pausing' | 'resuming' | 'interrupting' | 'steering';
	interface DispatchMutation {
		token: number;
		kind: DispatchMutationKind;
		chatId: string;
		entryId?: string;
	}

	let previewSelection = $state<QueuePreviewSelection | null>(null);
	let dispatchMutationToken = 0;
	let dispatchMutations = $state<Record<string, DispatchMutation>>({});
	const entries = $derived(queue?.entries ?? []);
	const queuedEntryCount = $derived(entries.length);
	const dispatchMutation = $derived(chatId ? (dispatchMutations[chatId] ?? null) : null);
	const localSteeringEntryId = $derived(
		dispatchMutation?.kind === 'steering' ? (dispatchMutation.entryId ?? null) : null,
	);
	const previewIndex = $derived.by(() => {
		if (entries.length === 0) return -1;
		const steeringEntryId = queue?.steeringEntryId ?? localSteeringEntryId;
		const steeringIndex = steeringEntryId
			? entries.findIndex((entry) => entry.id === steeringEntryId)
			: -1;
		if (steeringIndex >= 0) return steeringIndex;
		if (!chatId || previewSelection?.chatId !== chatId) return 0;

		const retainedIndex = entries.findIndex((entry) => entry.id === previewSelection?.entryId);
		return retainedIndex >= 0 ? retainedIndex : 0;
	});
	const previewEntry = $derived(entries[previewIndex] ?? null);
	const canBrowsePrevious = $derived(previewIndex > 0);
	const canBrowseNext = $derived(previewIndex >= 0 && previewIndex < queuedEntryCount - 1);
	const showQueueManager = $derived(queuedEntryCount > 1);
	const queueSteering = $derived(queue?.steeringEntryId != null);
	const previewSteering = $derived(
		queue?.steeringEntryId === previewEntry?.id || localSteeringEntryId === previewEntry?.id,
	);
	const showSteerAction = $derived(
		((previewIndex === 0 && canSteer) || previewSteering) && Boolean(onSteer),
	);
	const showInterruptAction = $derived(
		previewIndex === 0 && !queue?.pause && !queueSteering && canInterrupt && Boolean(onInterrupt),
	);
	let deletingEntryIds = $state<Set<string>>(new Set());
	const queueActionPending = $derived(dispatchMutation !== null);
	const queueMutationsBlocked = $derived(queueActionPending || queueSteering);
	const queueActions = $derived.by<ResponsiveSurfaceAction[]>(() => {
		const actions: ResponsiveSurfaceAction[] = [];
		const neutralButtonClass =
			'rounded-lg px-2.5 text-sm text-foreground hover:bg-accent hover:text-accent-foreground';

		if (showSteerAction && onSteer && previewEntry && queue) {
			const observedEntry = previewEntry;
			const expectedReorderRevision = queue.reorderRevision;
			const steerBusy = previewSteering;
			actions.push({
				id: 'steer',
				label: m.chat_queue_steer(),
				title: m.chat_queue_steer_queue(),
				icon: steerBusy ? Loader2 : Route,
				iconClass: steerBusy ? 'animate-spin' : undefined,
				onclick: () => {
					if (previewSteering) return;
					void mutateDispatch(
						'steering',
						() => onSteer(observedEntry, expectedReorderRevision),
						observedEntry.id,
					);
				},
				disabled: queueActionPending && !steerBusy,
				busy: steerBusy,
				priority: 1,
				showLabel: true,
				buttonClass: neutralButtonClass,
			});
		}

		if (showInterruptAction && onInterrupt) {
			actions.push({
				id: 'send-now',
				label: m.chat_queue_interrupt_and_send(),
				title: m.chat_queue_interrupt_and_send_queue(),
				icon: dispatchMutation?.kind === 'interrupting' ? Loader2 : FastForward,
				iconClass: dispatchMutation?.kind === 'interrupting' ? 'animate-spin' : undefined,
				onclick: () => void mutateDispatch('interrupting', onInterrupt),
				disabled: queueMutationsBlocked,
				busy: dispatchMutation?.kind === 'interrupting',
				priority: 0,
				showLabel: true,
				buttonClass: neutralButtonClass,
			});
		}

		if (showQueueManager) {
			actions.push({
				id: 'edit-queue',
				label: m.chat_queue_edit_queue(),
				icon: ListTodo,
				onclick: onOpenManager,
				disabled: queueMutationsBlocked,
				priority: 3,
				showLabel: true,
				buttonClass: neutralButtonClass,
			});
		}

		if (queue?.pause) {
			actions.push({
				id: 'resume-queue',
				label: m.chat_queue_resume(),
				title: m.chat_queue_resume_queue(),
				icon: dispatchMutation?.kind === 'resuming' ? Loader2 : Play,
				iconClass: dispatchMutation?.kind === 'resuming' ? 'animate-spin' : undefined,
				onclick: () => void mutateDispatch('resuming', () => onResume(queue.pause!.id)),
				disabled: queueMutationsBlocked,
				busy: dispatchMutation?.kind === 'resuming',
				priority: 2,
				showLabel: true,
				buttonClass:
					'rounded-lg bg-queue-action-bg px-2.5 text-sm text-queue-foreground hover:bg-queue-action-hover-bg hover:text-queue-foreground',
			});
		} else {
			actions.push({
				id: 'pause-queue',
				label: m.chat_queue_pause(),
				title: m.chat_queue_pause_queue(),
				icon: dispatchMutation?.kind === 'pausing' ? Loader2 : Pause,
				iconClass: dispatchMutation?.kind === 'pausing' ? 'animate-spin' : undefined,
				onclick: () => void mutateDispatch('pausing', onPause),
				disabled: queueMutationsBlocked,
				busy: dispatchMutation?.kind === 'pausing',
				priority: 2,
				showLabel: true,
				buttonClass: neutralButtonClass,
			});
		}

		return actions;
	});

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
		kind: DispatchMutationKind,
		action: () => void | Promise<void>,
		entryId?: string,
	): Promise<void> {
		if (!chatId || dispatchMutation || queueSteering) return;
		const operation: DispatchMutation = {
			token: ++dispatchMutationToken,
			kind,
			chatId,
			...(entryId ? { entryId } : {}),
		};
		dispatchMutations = { ...dispatchMutations, [operation.chatId]: operation };
		try {
			await action();
		} catch (error) {
			if (kind === 'pausing' || kind === 'resuming') {
				onQueueControlError(kind === 'pausing' ? 'pause' : 'resume', error);
			}
		} finally {
			if (dispatchMutations[operation.chatId]?.token === operation.token) {
				const { [operation.chatId]: _completed, ...remaining } = dispatchMutations;
				dispatchMutations = remaining;
			}
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
					disabled={deletingEntryIds.has(previewEntry.id) || queueMutationsBlocked}
					class="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
					title={m.chat_queue_edit_message()}
					aria-label={m.chat_queue_edit_message()}
				>
					<Pencil class="h-4 w-4" />
				</button>
				<button
					type="button"
					onclick={() => void deleteEntry(previewEntry.id)}
					disabled={deletingEntryIds.has(previewEntry.id) || queueMutationsBlocked}
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

		<footer class="flex items-center gap-3 border-t border-border px-3 py-2">
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
							disabled={!canBrowsePrevious || queueMutationsBlocked}
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
							disabled={!canBrowseNext || queueMutationsBlocked}
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

			<ResponsiveSurfaceActions
				actions={queueActions}
				menuLabel={m.chat_queue_actions()}
				class="ml-auto"
			/>
		</footer>
	</section>
{/if}
