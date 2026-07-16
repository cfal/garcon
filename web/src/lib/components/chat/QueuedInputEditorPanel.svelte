<script lang="ts">
	import { tick } from 'svelte';
	import type { QueuedInputEditorState } from '$lib/chat/conversation/queued-input-editor-state.svelte.js';
	import { ApiError } from '$lib/api/client.js';
	import * as m from '$lib/paraglide/messages.js';
	import { ListPlus, Loader2, RefreshCw, Save, Undo2 } from '@lucide/svelte';

	interface Props {
		editor: QueuedInputEditorState;
		onCreate: (content: string) => Promise<void>;
		onReplace: (entryId: string, content: string, expectedRevision: number) => Promise<void>;
		onClose: (restoreEntryId?: string | null) => void;
	}

	let { editor, onCreate, onReplace, onClose }: Props = $props();
	let editorTextarea: HTMLTextAreaElement | null = $state(null);
	const canQueueDraftAsNew = $derived(editor.phase === 'sent' || editor.phase === 'removed');

	$effect(() => {
		const entryId = editor.entryId;
		if (!entryId || !editorTextarea) return;
		void tick().then(() => editorTextarea?.focus());
	});

	function errorMessage(error: unknown): string {
		if (error instanceof ApiError || error instanceof Error) return error.message;
		return String(error);
	}

	async function saveEdit(): Promise<void> {
		if (!editor.canSave || !editor.entryId || editor.baseRevision === null) return;
		const entryId = editor.entryId;
		const draft = editor.draft;
		const baseRevision = editor.baseRevision;
		const sessionRevision = editor.sessionRevision;
		editor.mutation = 'saving';
		editor.error = null;
		try {
			await onReplace(entryId, draft, baseRevision);
			if (editor.matchesSession(entryId, sessionRevision)) onClose(entryId);
		} catch (error) {
			if (editor.matchesSession(entryId, sessionRevision)) editor.error = errorMessage(error);
		} finally {
			if (editor.matchesSession(entryId, sessionRevision)) editor.mutation = 'idle';
		}
	}

	async function replaceLatest(): Promise<void> {
		if (!editor.liveEntry || !editor.entryId || !editor.draft.trim()) return;
		editor.rebaseOnLatest();
		await saveEdit();
	}

	async function queueDraftAsNew(): Promise<void> {
		if (
			!canQueueDraftAsNew ||
			!editor.entryId ||
			!editor.draft.trim() ||
			editor.mutation !== 'idle'
		)
			return;
		const entryId = editor.entryId;
		const draft = editor.draft;
		const sessionRevision = editor.sessionRevision;
		editor.mutation = 'queueing-draft';
		editor.error = null;
		try {
			await onCreate(draft);
			if (editor.matchesSession(entryId, sessionRevision)) onClose(entryId);
		} catch (error) {
			if (editor.matchesSession(entryId, sessionRevision)) editor.error = errorMessage(error);
		} finally {
			if (editor.matchesSession(entryId, sessionRevision)) editor.mutation = 'idle';
		}
	}

	function handleEditorKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey) || !editor.canSave) return;
		event.preventDefault();
		void saveEdit();
	}
</script>

<section class="shrink-0 border-b border-border bg-muted/30 px-5 py-4 sm:px-6">
	<div class="mb-2 flex items-center justify-between gap-3">
		<h3 class="text-sm font-medium">{m.chat_queue_edit_message()}</h3>
		<button
			type="button"
			onclick={() => onClose()}
			class="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			{m.chat_queue_discard()}
		</button>
	</div>

	{#if editor.phase === 'conflict'}
		<div
			class="mb-3 rounded-lg border border-status-warning-border bg-status-warning/10 px-3 py-2 text-sm text-status-warning-muted-foreground"
			role="status"
		>
			<p class="font-medium">{m.chat_queue_changed_elsewhere()}</p>
			<p class="mt-0.5 text-xs">{m.chat_queue_changed_elsewhere_detail()}</p>
		</div>
	{:else if editor.phase === 'dispatching' || editor.phase === 'sent'}
		<div class="mb-3 rounded-lg border border-border bg-card px-3 py-2 text-sm" role="status">
			<p class="font-medium">{m.chat_queue_already_sent()}</p>
			{#if editor.phase === 'dispatching'}
				<p class="mt-0.5 text-xs text-muted-foreground">{m.chat_queue_agent_processing()}</p>
			{/if}
		</div>
	{:else if editor.phase === 'removed'}
		<div class="mb-3 rounded-lg border border-border bg-card px-3 py-2 text-sm" role="status">
			<p class="font-medium">{m.chat_queue_no_longer_queued()}</p>
		</div>
	{/if}

	<label>
		<span class="sr-only">{m.chat_queue_edit_message()}</span>
		<textarea
			bind:this={editorTextarea}
			bind:value={editor.draft}
			onkeydown={handleEditorKeydown}
			rows="4"
			class="max-h-48 min-h-24 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
		></textarea>
	</label>

	{#if editor.error}
		<p class="mt-2 text-sm text-destructive" role="alert">{editor.error}</p>
	{/if}

	<div class="mt-3 flex flex-wrap items-center gap-2">
		{#if editor.phase === 'editable'}
			<button
				type="button"
				onclick={() => void saveEdit()}
				disabled={!editor.canSave}
				class="inline-flex min-h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
			>
				{#if editor.mutation === 'saving'}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<Save class="h-4 w-4" />
				{/if}
				{m.chat_queue_save_edit()}
			</button>
		{:else if editor.phase === 'conflict'}
			<button
				type="button"
				onclick={() => editor.reloadLatest()}
				class="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<RefreshCw class="h-4 w-4" />
				{m.chat_queue_reload_latest()}
			</button>
			<button
				type="button"
				onclick={() => void replaceLatest()}
				disabled={!editor.draft.trim() || editor.mutation !== 'idle'}
				class="inline-flex min-h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
			>
				<Undo2 class="h-4 w-4" />
				{m.chat_queue_replace_latest()}
			</button>
		{:else if canQueueDraftAsNew}
			<button
				type="button"
				onclick={() => void queueDraftAsNew()}
				disabled={!editor.draft.trim() || editor.mutation !== 'idle'}
				class="inline-flex min-h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
			>
				{#if editor.mutation === 'queueing-draft'}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<ListPlus class="h-4 w-4" />
				{/if}
				{m.chat_queue_queue_draft_as_new()}
			</button>
		{/if}
	</div>
</section>
