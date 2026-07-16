<script lang="ts">
	import { tick } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import type { QueueEntry, QueueState } from '$lib/types/chat';
	import type { QueuedInputEditorState } from '$lib/chat/conversation/queued-input-editor-state.svelte.js';
	import { ApiError } from '$lib/api/client.js';
	import QueuedInputEditorPanel from './QueuedInputEditorPanel.svelte';
	import QueuedInputRow from './QueuedInputRow.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { Loader2 } from '@lucide/svelte';

	interface Props {
		open: boolean;
		queue: QueueState | null;
		editor: QueuedInputEditorState;
		onClose: () => void;
		onCreate: (content: string) => Promise<void>;
		onReplace: (entryId: string, content: string, expectedRevision: number) => Promise<void>;
		onDelete: (entryId: string) => Promise<void>;
		onResume: () => Promise<void>;
	}

	let { open, queue, editor, onClose, onCreate, onReplace, onDelete, onResume }: Props = $props();
	let listContainer: HTMLDivElement | null = $state(null);
	let listHeading: HTMLHeadingElement | null = $state(null);
	let deletingIds = $state<Set<string>>(new Set());
	let rowErrors = $state<Record<string, string>>({});
	let resuming = $state(false);
	let resumeError = $state<string | null>(null);

	const entries = $derived(queue?.entries ?? []);
	const queuedCount = $derived(entries.length);
	const editorOpen = $derived(editor.phase !== 'closed');

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

	function errorMessage(error: unknown): string {
		if (error instanceof ApiError || error instanceof Error) return error.message;
		return String(error);
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

	async function resumeQueue(): Promise<void> {
		if (resuming) return;
		resuming = true;
		resumeError = null;
		try {
			await onResume();
		} catch (error) {
			resumeError = errorMessage(error);
		} finally {
			resuming = false;
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
			{#if queue?.paused}
				<div class="mt-3 flex flex-wrap items-center justify-between gap-2" role="status">
					<span class="text-sm font-medium text-status-warning-muted-foreground">
						{m.chat_queue_paused()}
					</span>
					<button
						type="button"
						onclick={() => void resumeQueue()}
						disabled={resuming}
						class="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
					>
						{#if resuming}<Loader2 class="h-4 w-4 animate-spin" />{/if}
						{m.chat_queue_send_now()}
					</button>
				</div>
				{#if resumeError}
					<p class="mt-2 text-sm text-destructive" role="alert">{resumeError}</p>
				{/if}
			{/if}
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
				<div class="divide-y divide-border">
					{#each entries as entry, index (entry.id)}
						<svelte:boundary {failed}>
							<QueuedInputRow
								{entry}
								position={index + 1}
								error={rowErrors[entry.id]}
								deleting={deletingIds.has(entry.id)}
								editDisabled={editorOpen || deletingIds.has(entry.id)}
								deleteDisabled={deletingIds.has(entry.id) ||
									(editor.entryId === entry.id && editor.mutation !== 'idle')}
								onEdit={beginEdit}
								onDelete={(entryId) => void deleteEntry(entryId)}
							/>
						</svelte:boundary>
					{/each}
				</div>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
