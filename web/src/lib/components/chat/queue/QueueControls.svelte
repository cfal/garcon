<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import type { ChatQueueState, QueueEntry } from '$lib/types/chat';
	import type { QueueEntryPlacement } from '$shared/chat-command-contracts';
	import { CHAT_DOCK_SURFACE_CLASS } from '$lib/chat/conversation/chat-max-width.js';
	import { isQueuedInputDragData } from './queued-input-dnd.js';
	import QueuedInputTrayRow from './QueuedInputTrayRow.svelte';
	import { QueuedInputListController } from './QueuedInputListController.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Pause from '@lucide/svelte/icons/pause';
	import Play from '@lucide/svelte/icons/play';

	interface Props {
		chatId: string | null;
		queue: ChatQueueState | null;
		canInterrupt?: boolean;
		canSteer?: boolean;
		onInterrupt?: () => void | Promise<void>;
		onSteer?: (entry: QueueEntry, expectedReorderRevision: number) => void | Promise<void>;
		onPause: () => Promise<void>;
		onResume: (pauseId: string) => Promise<void>;
		onQueueControlError: (
			chatId: string,
			action: 'pause' | 'resume' | 'move',
			error: unknown,
		) => void;
		onEdit: (entry: QueueEntry) => void;
		onDelete: (entryId: string) => Promise<void>;
		onMove: (
			source: QueueEntry,
			target: QueueEntry,
			placement: QueueEntryPlacement,
			reorderRevision: number,
		) => Promise<void>;
		announcementsEnabled?: boolean;
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
		onDelete,
		onMove,
		announcementsEnabled = true,
	}: Props = $props();

	type MutationKind = 'pausing' | 'resuming' | 'interrupting' | 'steering' | 'deleting' | 'moving';
	interface Mutation {
		kind: MutationKind;
		entryId?: string;
	}
	let mutations = $state<Record<string, Mutation>>({});
	let expandedChatId = $state<string | null>(null);
	let listElement = $state<HTMLDivElement | null>(null);
	const entries = $derived(queue?.entries ?? []);
	const listController = new QueuedInputListController();
	const snapshot = $derived(listController.virtual.snapshot);
	const renderedItems = $derived(listController.items(snapshot, entries));
	let notice = $state<{ chatId: string; message: string } | null>(null);
	const pauseId = $derived(queue?.pause?.id);
	const pauseDetail = $derived.by(() => {
		switch (queue?.pause?.kind) {
			case 'manual':
				return m.chat_queue_paused_detail();
			case 'queued-turn-failed':
				return m.chat_queue_pause_failed_detail();
			case 'completion-uncertain':
				return m.chat_queue_pause_completion_uncertain_detail();
			case 'unknown':
				return m.chat_queue_pause_unknown_detail();
			default:
				return m.chat_queue_follow_up_detail();
		}
	});
	const affectedEntryRemoved = $derived.by(() => {
		const pause = queue?.pause;
		return Boolean(
			pause &&
			'entryId' in pause &&
			pause.entryId &&
			!entries.some((entry) => entry.id === pause.entryId),
		);
	});
	const mutation = $derived(chatId ? mutations[chatId] : undefined);
	const blocked = $derived(Boolean(mutation) || queue?.steeringEntryId != null);
	const expanded = $derived(chatId !== null && expandedChatId === chatId);
	const visibleNotice = $derived(notice?.chatId === chatId ? notice : null);
	let scrollTarget: { chatId: string; element: HTMLDivElement } | null = null;

	$effect(() => {
		if (!chatId || !listElement) return;
		if (scrollTarget?.chatId === chatId && scrollTarget.element === listElement) return;
		scrollTarget = { chatId, element: listElement };
		listElement.scrollTop = 0;
	});
	$effect.pre(() => {
		const targetChatId = chatId;
		const currentEntries = entries;
		untrack(() => listController.update(targetChatId, currentEntries));
	});
	onDestroy(() => listController.virtual.destroy());

	$effect(() => {
		if (!listElement || !chatId) return;
		const element = listElement;
		const targetChatId = chatId;
		let disposed = false;
		let cleanup: (() => void) | undefined;
		void import('@atlaskit/pragmatic-drag-and-drop-auto-scroll/element').then(
			({ autoScrollForElements }) => {
				if (disposed) return;
				cleanup = autoScrollForElements({
					element,
					canScroll: ({ source }) =>
						!blocked && isQueuedInputDragData(source.data) && source.data.chatId === targetChatId,
					getAllowedAxis: () => 'vertical',
				});
			},
		);
		return () => {
			disposed = true;
			cleanup?.();
		};
	});

	async function mutate(
		kind: MutationKind,
		action: () => void | Promise<void>,
		entryId?: string,
	): Promise<void> {
		const operationChatId = chatId;
		if (!operationChatId || blocked) return;
		mutations = { ...mutations, [operationChatId]: { kind, entryId } };
		notice = null;
		try {
			await action();
			if (kind === 'moving' && chatId === operationChatId)
				notice = { chatId: operationChatId, message: m.chat_queue_move_success() };
		} catch (error) {
			if (kind === 'pausing' || kind === 'resuming') {
				onQueueControlError(operationChatId, kind === 'pausing' ? 'pause' : 'resume', error);
			} else if (kind === 'moving') {
				onQueueControlError(operationChatId, 'move', error);
			}
		} finally {
			const { [operationChatId]: _completed, ...remaining } = mutations;
			mutations = remaining;
		}
	}

	async function moveRelative(
		sourceId: string,
		targetId: string,
		placement: QueueEntryPlacement,
	): Promise<void> {
		if (!queue || blocked) return;
		const source = entries.find((entry) => entry.id === sourceId);
		const target = entries.find((entry) => entry.id === targetId);
		if (!source || !target || source === target) return;
		const revision = queue.reorderRevision;
		await mutate('moving', () => onMove(source, target, placement, revision), source.id);
	}
</script>

{#if queue && chatId && entries.length > 0}
	<section
		class={`${CHAT_DOCK_SURFACE_CLASS} flex min-h-0 flex-col`}
		aria-label={m.chat_queue_dialog_title()}
		data-queue-status-summary
		data-queue-chat-id={chatId}
		tabindex="-1"
	>
		<header class="flex shrink-0 flex-wrap items-center gap-x-2 border-b border-border px-3 py-1.5">
			<span
				class="text-xs font-medium text-foreground"
				aria-live={announcementsEnabled ? 'polite' : 'off'}
				aria-atomic="true">{m.chat_queue_pending_count({ count: entries.length })}</span
			>
			{#if queue.pause}<span class="min-w-0 truncate text-xs text-queue-foreground"
					>{queue.pause.kind === 'manual'
						? m.chat_queue_paused()
						: m.chat_queue_needs_attention()}</span
				>{/if}
			<div class="ml-auto flex shrink-0 items-center gap-1">
				<button
					type="button"
					onclick={() =>
						void mutate(
							pauseId ? 'resuming' : 'pausing',
							pauseId ? () => onResume(pauseId) : onPause,
						)}
					disabled={blocked}
					class="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:pointer-fine:min-h-8"
					aria-label={pauseId ? m.chat_queue_resume() : m.chat_queue_pause()}
					title={pauseId ? m.chat_queue_resume_queue() : m.chat_queue_pause_queue()}
				>
					{#if mutation?.kind === 'pausing' || mutation?.kind === 'resuming'}<Loader2
							class="size-3.5 animate-spin"
						/>{:else if pauseId}<Play class="size-3.5" />{:else}<Pause class="size-3.5" />{/if}
					{pauseId ? m.chat_queue_resume() : m.chat_queue_pause()}
				</button>
				<button
					type="button"
					onclick={() => {
						expandedChatId = expanded ? null : chatId;
						listController.resetExpansion();
					}}
					aria-expanded={expanded}
					aria-label={expanded ? m.chat_queue_collapse_all() : m.chat_queue_expand_all()}
					title={expanded ? m.chat_queue_collapse_all() : m.chat_queue_expand_all()}
					class="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:min-h-8"
				>
					{#if expanded}<ChevronsDownUp class="size-3.5" />{:else}<ChevronsUpDown
							class="size-3.5"
						/>{/if}
					{expanded ? m.common_collapse_all() : m.common_expand_all()}
				</button>
			</div>
			<p class="basis-full pb-1 text-xs text-muted-foreground">
				{pauseDetail}
				{#if affectedEntryRemoved}
					{m.chat_queue_pause_affected_removed()}{/if}
			</p>
		</header>
		<div
			bind:this={listElement}
			data-queue-list
			class={`min-h-0 overflow-y-auto overscroll-contain ${expanded ? 'max-h-[40dvh]' : 'max-h-[25dvh]'}`}
			{@attach listController.virtual.viewport}
		>
			<ol
				class="relative"
				style:height={`${snapshot.sizerSize}px`}
				{@attach listController.virtual.sizer}
			>
				{#each renderedItems as { entry, virtualItem } (`${chatId}:${virtualItem.key}`)}
					{@const index = virtualItem.index}
					<svelte:boundary>
						{@const steering =
							queue.steeringEntryId === entry.id ||
							(mutation?.kind === 'steering' && mutation.entryId === entry.id)}
						<QueuedInputTrayRow
							{chatId}
							{entry}
							position={index + 1}
							{virtualItem}
							count={entries.length}
							measurement={listController.virtual.item(virtualItem.key)}
							expanded={listController.isExpanded(entry.id, expanded)}
							onToggle={() => listController.toggleExpanded(entry.id, expanded)}
							onRetain={(reason, active) => listController.retain(entry.id, reason, active)}
							{blocked}
							{steering}
							deleting={mutation?.kind === 'deleting' && mutation.entryId === entry.id}
							canSteer={canSteer && entry.kind !== 'steer' && Boolean(onSteer)}
							canInterrupt={index === 0 && canInterrupt && !queue.pause && Boolean(onInterrupt)}
							onSteer={() => {
								if (onSteer && queue && entries.some((candidate) => candidate.id === entry.id)) {
									const revision = queue.reorderRevision;
									void mutate('steering', () => onSteer!(entry, revision), entry.id);
								}
							}}
							onInterrupt={() => {
								if (onInterrupt && entries[0]?.id === entry.id)
									void mutate('interrupting', onInterrupt);
							}}
							onEdit={() => onEdit(entry)}
							onDelete={() => void mutate('deleting', () => onDelete(entry.id), entry.id)}
							onDrop={moveRelative}
						/>
						{#snippet failed(error)}<li class="px-3 py-2 text-xs text-destructive" role="alert">
								{m.chat_queue_item_render_failed({ detail: String(error) })}
							</li>{/snippet}
					</svelte:boundary>
				{/each}
			</ol>
		</div>
		{#if visibleNotice}<p class="sr-only" aria-live={announcementsEnabled ? 'polite' : 'off'}>
				{visibleNotice.message}
			</p>{/if}
	</section>
{/if}
