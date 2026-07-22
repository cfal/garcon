<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import type { ChatQueueState, QueueEntry, QueuePause } from '$lib/types/chat';
	import type { QueueEntryPlacement } from '$shared/chat-command-contracts';
	import type { QueuedInputEditorState } from '$lib/chat/conversation/queued-input-editor-state.svelte.js';
	import { ApiError } from '$lib/api/client.js';
	import { CommandOutcomeUnknownError } from '$lib/chat/conversation/idempotent-command.js';
	import { errorMessage } from '$lib/utils/error-message.js';
	import QueuedInputEditorPanel from './QueuedInputEditorPanel.svelte';
	import QueuedInputRow from './QueuedInputRow.svelte';
	import { isQueuedInputDragData } from './queued-input-dnd.js';
	import * as m from '$lib/paraglide/messages.js';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Pause from '@lucide/svelte/icons/pause';
	import Play from '@lucide/svelte/icons/play';

	interface Props {
		open: boolean;
		queue: ChatQueueState | null;
		editor: QueuedInputEditorState;
		onClose: () => void;
		onCreate: (content: string) => Promise<void>;
		onReplace: (entryId: string, content: string, expectedRevision: number) => Promise<void>;
		onDelete: (entryId: string) => Promise<void>;
		onMove: (
			source: QueueEntry,
			target: QueueEntry,
			placement: QueueEntryPlacement,
			reorderRevision: number,
		) => Promise<void>;
		onPause: () => Promise<void>;
		onResume: (pauseId: string) => Promise<void>;
	}

	let {
		open,
		queue,
		editor,
		onClose,
		onCreate,
		onReplace,
		onDelete,
		onMove,
		onPause,
		onResume,
	}: Props = $props();
	let listContainer: HTMLDivElement | null = $state(null);
	let listHeading: HTMLHeadingElement | null = $state(null);
	let deletingIds = $state<Set<string>>(new Set());
	let rowErrors = $state<Record<string, string>>({});
	let queueMutation = $state<'idle' | 'pausing' | 'resuming'>('idle');
	let queueMutationError = $state<string | null>(null);
	let movingEntryId = $state<string | null>(null);
	let moveError = $state<string | null>(null);
	let moveAnnouncement = $state('');
	let dragEnabled = $state(false);

	const entries = $derived(queue?.entries ?? []);
	const queuedCount = $derived(entries.length);
	const editorOpen = $derived(editor.phase !== 'closed');
	const pause = $derived(queue?.pause ?? null);
	const pauseDetail = $derived(pause ? queuePauseDetail(pause) : null);
	const affectedEntryRemoved = $derived(
		Boolean(
			pause &&
			'entryId' in pause &&
			pause.entryId &&
			!entries.some((entry) => entry.id === pause.entryId),
		),
	);
	const movesBlocked = $derived(
		editorOpen || deletingIds.size > 0 || movingEntryId !== null,
	);

	onMount(() => {
		if (typeof window.matchMedia !== 'function') return;
		const media = window.matchMedia('(hover: hover) and (pointer: fine)');
		const updateDragCapability = () => (dragEnabled = media.matches);
		updateDragCapability();
		media.addEventListener('change', updateDragCapability);
		return () => media.removeEventListener('change', updateDragCapability);
	});

	$effect(() => {
		const liveIds = new Set(entries.map((entry) => entry.id));
		const staleErrorIds = Object.keys(rowErrors).filter((entryId) => !liveIds.has(entryId));
		if (staleErrorIds.length > 0) {
			const nextErrors = { ...rowErrors };
			for (const entryId of staleErrorIds) delete nextErrors[entryId];
			rowErrors = nextErrors;
		}
		if ([...deletingIds].some((entryId) => !liveIds.has(entryId))) {
			deletingIds = new Set([...deletingIds].filter((entryId) => liveIds.has(entryId)));
		}
	});

	$effect(() => {
		if (!listContainer || !dragEnabled || entries.length === 0) return;
		let disposed = false;
		let cleanup: (() => void) | undefined;
		const frame = requestAnimationFrame(() => {
			if (
				!listContainer ||
				listContainer.scrollHeight <= listContainer.clientHeight
			) {
				return;
			}
			void import('@atlaskit/pragmatic-drag-and-drop-auto-scroll/element').then((module) => {
				if (
					disposed ||
					!listContainer ||
					listContainer.scrollHeight <= listContainer.clientHeight
				) {
					return;
				}
				cleanup = module.autoScrollForElements({
					element: listContainer,
					canScroll: ({ source }) => isQueuedInputDragData(source.data),
					getAllowedAxis: () => 'vertical',
				});
			});
		});
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			cleanup?.();
		};
	});

	function queuePauseDetail(value: QueuePause): string | null {
		switch (value.kind) {
			case 'manual':
				return null;
			case 'queued-turn-failed':
				return m.chat_queue_pause_failed_detail();
			case 'completion-uncertain':
				return m.chat_queue_pause_completion_uncertain_detail();
			case 'unknown':
				return m.chat_queue_pause_unknown_detail();
		}
	}

	function handleOpenChange(nextOpen: boolean): void {
		if (!nextOpen) onClose();
	}

	function beginEdit(entry: QueueEntry): void {
		if (editorOpen || editor.mutation !== 'idle') return;
		editor.begin(entry);
	}

	function closeEditor(restoreEntryId: string | null = editor.entryId): void {
		editor.close();
		if (!restoreEntryId) return;
		void tick().then(() => {
			const editButton = [
				...(listContainer?.querySelectorAll<HTMLButtonElement>('[data-queue-edit-id]') ?? []),
			].find((button) => button.dataset.queueEditId === restoreEntryId);
			if (editButton) {
				editButton.focus();
				return;
			}
			listHeading?.focus();
		});
	}

	async function mutateQueueControl(
		mutation: Exclude<typeof queueMutation, 'idle'>,
		action: () => Promise<void>,
	): Promise<void> {
		if (queueMutation !== 'idle') return;
		queueMutation = mutation;
		queueMutationError = null;
		try {
			await action();
		} catch (error) {
			queueMutationError = errorMessage(error);
		} finally {
			if (queueMutation === mutation) queueMutation = 'idle';
		}
	}

	async function deleteEntry(entryId: string): Promise<void> {
		if (deletingIds.has(entryId)) return;
		deletingIds = new Set([...deletingIds, entryId]);
		const nextErrors = { ...rowErrors };
		delete nextErrors[entryId];
		rowErrors = nextErrors;
		try {
			await onDelete(entryId);
		} catch (error) {
			if (
				!(error instanceof ApiError) ||
				(error.errorCode !== 'QUEUE_ENTRY_ALREADY_SENT' &&
					error.errorCode !== 'QUEUE_ENTRY_NOT_FOUND')
			) {
				rowErrors = { ...rowErrors, [entryId]: errorMessage(error) };
			}
		} finally {
			const nextDeleting = new Set(deletingIds);
			nextDeleting.delete(entryId);
			deletingIds = nextDeleting;
		}
	}

	function moveFailureMessage(error: unknown): string {
		if (error instanceof CommandOutcomeUnknownError) return m.chat_queue_move_unknown();
		if (error instanceof ApiError) {
			if (
				error.errorCode === 'QUEUE_ENTRY_REORDER_CONFLICT' ||
				error.errorCode === 'QUEUE_ENTRY_REVISION_CONFLICT'
			) {
				return m.chat_queue_move_conflict();
			}
			if (
				error.errorCode === 'QUEUE_ENTRY_ALREADY_SENT' ||
				error.errorCode === 'QUEUE_ENTRY_NOT_FOUND'
			) {
				return m.chat_queue_move_departed();
			}
		}
		return errorMessage(error);
	}

	async function moveRelative(
		sourceEntryId: string,
		targetEntryId: string,
		placement: QueueEntryPlacement,
	): Promise<void> {
		if (movesBlocked || !queue) return;
		const source = entries.find((entry) => entry.id === sourceEntryId);
		const target = entries.find((entry) => entry.id === targetEntryId);
		if (!source || !target) {
			moveError = m.chat_queue_move_conflict();
			return;
		}

		movingEntryId = source.id;
		moveError = null;
		moveAnnouncement = '';
		try {
			await onMove(source, target, placement, queue.reorderRevision);
			moveAnnouncement = m.chat_queue_move_success();
		} catch (error) {
			moveError = moveFailureMessage(error);
		} finally {
			if (movingEntryId === source.id) movingEntryId = null;
		}
	}

	async function moveEntry(entryId: string, delta: -1 | 1): Promise<void> {
		const sourceIndex = entries.findIndex((entry) => entry.id === entryId);
		if (sourceIndex < 0) {
			moveError = m.chat_queue_move_conflict();
			return;
		}
		const target = entries[sourceIndex + delta];
		if (!target) return;
		await moveRelative(entryId, target.id, delta === -1 ? 'before' : 'after');
	}

	async function dropEntry(
		sourceEntryId: string,
		targetEntryId: string,
		placement: QueueEntryPlacement,
	): Promise<void> {
		await moveRelative(sourceEntryId, targetEntryId, placement);
		await tick();
		const moveButton = [
			...(listContainer?.querySelectorAll<HTMLButtonElement>('[data-queue-move-id]') ?? []),
		].find((button) => button.dataset.queueMoveId === sourceEntryId && !button.disabled);
		if (moveButton) {
			moveButton.focus();
			return;
		}
		listHeading?.focus();
	}
</script>

{#snippet failed(error: unknown)}
	<div class="border-b border-border px-5 py-4 text-sm text-destructive">
		{m.chat_queue_item_render_failed({ detail: errorMessage(error) })}
	</div>
{/snippet}

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[80dvh] sm:max-h-[44rem] sm:max-w-2xl sm:rounded-lg sm:border"
		showCloseButton={true}
	>
		<Dialog.Header class="shrink-0 border-b border-border px-5 py-4 sm:px-6">
			<div class="flex items-baseline gap-2 pr-8">
				<Dialog.Title class="text-lg font-semibold">{m.chat_queue_dialog_title()}</Dialog.Title>
				<span
					class="text-sm tabular-nums text-muted-foreground"
					aria-live="polite"
					aria-atomic="true"
				>
					{m.chat_queue_pending_count({ count: queuedCount })}
				</span>
			</div>
			<Dialog.Description class="sr-only">{m.chat_queue_dialog_description()}</Dialog.Description>
			{#if pause}
				<div class="mt-3 flex flex-wrap items-start justify-between gap-3" role="status">
					<div class="min-w-0 flex-1 text-sm">
						<p class="font-medium text-status-warning-muted-foreground">
							{pause.kind === 'manual' ? m.chat_queue_paused() : m.chat_queue_needs_attention()}
						</p>
						{#if pauseDetail}<p class="mt-1 text-muted-foreground">{pauseDetail}</p>{/if}
						{#if affectedEntryRemoved}
							<p class="mt-1 text-muted-foreground">{m.chat_queue_pause_affected_removed()}</p>
						{/if}
					</div>
					<button
						type="button"
						onclick={() => void mutateQueueControl('resuming', () => onResume(pause.id))}
						disabled={queueMutation !== 'idle'}
						class="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
					>
						{#if queueMutation === 'resuming'}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<Play class="h-4 w-4" />
						{/if}
						{m.chat_queue_resume()}
					</button>
				</div>
			{:else if entries.length > 0}
				<div class="mt-3 flex justify-end">
					<button
						type="button"
						onclick={() => void mutateQueueControl('pausing', onPause)}
						disabled={queueMutation !== 'idle'}
						class="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
					>
						{#if queueMutation === 'pausing'}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<Pause class="h-4 w-4" />
						{/if}
						{m.chat_queue_pause()}
					</button>
				</div>
			{/if}
			{#if queueMutationError}
				<p class="mt-2 text-sm text-destructive" role="alert">{queueMutationError}</p>
			{/if}
			{#if moveError}
				<p class="mt-2 text-sm text-destructive" role="alert">{moveError}</p>
			{/if}
			<p class="sr-only" aria-live="polite" aria-atomic="true">{moveAnnouncement}</p>
		</Dialog.Header>

		{#if editorOpen}
			<QueuedInputEditorPanel {editor} {onCreate} {onReplace} onClose={closeEditor} />
		{/if}

		<div bind:this={listContainer} class="min-h-0 flex-1 overflow-y-auto">
			<h3 bind:this={listHeading} tabindex="-1" class="sr-only" data-queue-list-heading>
				{m.chat_queue_dialog_title()}
			</h3>
			{#if entries.length === 0}
				<div
					class="flex min-h-40 items-center justify-center px-5 py-10 text-center text-sm text-muted-foreground"
				>
					{m.chat_queue_empty()}
				</div>
			{:else}
				<ol class="divide-y divide-border">
					{#each entries as entry, index (entry.id)}
						<svelte:boundary {failed}>
							<QueuedInputRow
								{entry}
								position={index + 1}
								error={rowErrors[entry.id]}
								deleting={deletingIds.has(entry.id)}
								editDisabled={editorOpen ||
									deletingIds.has(entry.id) ||
									movingEntryId === entry.id}
								deleteDisabled={deletingIds.has(entry.id) ||
									(editor.entryId === entry.id && editor.mutation !== 'idle') ||
									movingEntryId === entry.id}
								movePending={movingEntryId === entry.id}
								moveBlocked={movesBlocked}
								canMoveUp={index > 0}
								canMoveDown={index < entries.length - 1}
								{dragEnabled}
								onEdit={beginEdit}
								onDelete={(entryId) => void deleteEntry(entryId)}
								onMove={moveEntry}
								onDrop={dropEntry}
								onFocusFallback={() => listHeading?.focus()}
							/>
						</svelte:boundary>
					{/each}
				</ol>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
