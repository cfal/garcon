<script lang="ts">
	import { tick } from 'svelte';
	import type { QueuedInputEditorState } from '$lib/chat/conversation/queued-input-editor-state.svelte.js';
	import PromptTextField from '$lib/components/prompt-editor/PromptTextField.svelte';
	import { errorMessage } from '$lib/utils/error-message.js';
	import { CommandOutcomeUnknownError } from '$lib/chat/conversation/idempotent-command.js';
	import * as m from '$lib/paraglide/messages.js';
	import ListPlus from '@lucide/svelte/icons/list-plus';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Save from '@lucide/svelte/icons/save';
	import Undo2 from '@lucide/svelte/icons/undo-2';

	interface Props {
		editor: QueuedInputEditorState;
		textarea?: HTMLTextAreaElement | null;
		canRefinePrompt: boolean;
		isPromptRefinementPending: boolean;
		onCreate: (content: string) => Promise<void>;
		onReplace: (entryId: string, content: string, expectedRevision: number) => Promise<void>;
		onExpand: () => void;
		onRefinePrompt: () => void;
		onClose: (restoreEntryId?: string | null) => void;
	}

	let {
		editor,
		textarea = $bindable(null),
		canRefinePrompt,
		isPromptRefinementPending,
		onCreate,
		onReplace,
		onExpand,
		onRefinePrompt,
		onClose,
	}: Props = $props();
	const canQueueDraftAsNew = $derived(
		(editor.phase === 'sent' || editor.phase === 'removed') &&
			!editor.mutationBlocked &&
			!editor.queueDraftOutcomeUnknown &&
			!isPromptRefinementPending,
	);
	// One commit gate shared by the save button and the Cmd/Ctrl+Enter shortcut.
	const canCommit = $derived(editor.canSave && !isPromptRefinementPending);
	// Status precedence mirrors the lockouts: a steering draft reports its own
	// state before the sibling-steering lockout, and departed drafts report their
	// departure only when nothing is steering.
	const statusNotice = $derived.by(() => {
		if (editor.phase === 'steering') return m.chat_queue_steering();
		if (editor.mutationBlocked) return m.chat_queue_other_message_steering();
		if (editor.phase === 'sent') return m.chat_queue_already_sent();
		if (editor.phase === 'removed') return m.chat_queue_no_longer_queued();
		return null;
	});
	const describedBy = $derived.by(() => {
		const ids: string[] = [];
		if (editor.phase === 'conflict' || statusNotice !== null) ids.push('queued-input-status');
		if (editor.error) ids.push('queued-input-error');
		return ids.join(' ');
	});

	$effect(() => {
		const entryId = editor.entryId;
		if (!entryId || !textarea) return;
		void tick().then(() => textarea?.focus());
	});

	async function saveEdit(): Promise<void> {
		if (!canCommit || !editor.entryId || editor.baseRevision === null) return;
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
		if (
			editor.mutationBlocked ||
			isPromptRefinementPending ||
			!editor.liveEntry ||
			!editor.entryId ||
			!editor.draft.trim()
		)
			return;
		editor.rebaseOnLatest();
		await saveEdit();
	}

	async function queueDraftAsNew(): Promise<void> {
		if (
			!canQueueDraftAsNew ||
			editor.mutation !== 'idle' ||
			!editor.entryId ||
			!editor.draft.trim()
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
			if (editor.matchesSession(entryId, sessionRevision)) {
				if (error instanceof CommandOutcomeUnknownError) {
					editor.markQueueDraftOutcomeUnknown(m.chat_notice_queue_outcome_unconfirmed());
				} else {
					editor.error = errorMessage(error);
				}
			}
		} finally {
			if (editor.matchesSession(entryId, sessionRevision)) editor.mutation = 'idle';
		}
	}

	function handleEditorKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey) || !canCommit) return;
		event.preventDefault();
		void saveEdit();
	}
</script>

<section class="flex flex-col gap-2">
	<div class="flex items-center justify-between gap-3">
		<h4 class="text-sm font-medium">{m.chat_queue_edit_message()}</h4>
		<button
			type="button"
			onclick={() => onClose()}
			disabled={editor.mutation !== 'idle'}
			class="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
		>
			{m.chat_queue_discard()}
		</button>
	</div>

	{#if editor.phase === 'conflict'}
		<div
			id="queued-input-status"
			class="rounded-lg border border-status-warning-border bg-status-warning/10 px-3 py-2 text-sm text-status-warning-muted-foreground"
			role="status"
		>
			<p class="font-medium">{m.chat_queue_changed_elsewhere()}</p>
			<p class="mt-0.5 text-xs">{m.chat_queue_changed_elsewhere_detail()}</p>
		</div>
	{:else if statusNotice}
		<div
			id="queued-input-status"
			class="rounded-lg border border-border bg-card px-3 py-2 text-sm"
			role="status"
		>
			<p class="font-medium">{statusNotice}</p>
		</div>
	{/if}

	<label class="sr-only" for="queued-input-draft">{m.chat_queue_edit_message()}</label>
	<PromptTextField
		id="queued-input-draft"
		bind:ref={textarea}
		bind:value={editor.draft}
		onkeydown={handleEditorKeydown}
		rows={4}
		invalid={false}
		readOnly={editor.mutationBlocked || isPromptRefinementPending}
		disabled={editor.mutation !== 'idle'}
		describedBy={describedBy}
		textareaClass="min-h-24 max-h-48 placeholder:text-muted-foreground"
		canExpand={editor.mutation === 'idle'}
		expandLabel={m.chat_queue_open_expanded_editor()}
		{canRefinePrompt}
		{isPromptRefinementPending}
		{onExpand}
		{onRefinePrompt}
	/>

	{#if editor.error && editor.queueDraftOutcomeUnknown}
		<p id="queued-input-error" class="text-sm text-status-warning-muted-foreground" role="status">
			{editor.error}
		</p>
	{:else if editor.error}
		<p id="queued-input-error" class="text-sm text-destructive" role="alert">{editor.error}</p>
	{/if}

	<div class="flex flex-wrap items-center gap-2">
		{#if editor.phase === 'editable'}
			<button
				type="button"
				onclick={() => void saveEdit()}
				disabled={!canCommit}
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
				disabled={isPromptRefinementPending || editor.mutation !== 'idle'}
				class="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
			>
				<RefreshCw class="h-4 w-4" />
				{m.chat_queue_reload_latest()}
			</button>
			<button
				type="button"
				onclick={() => void replaceLatest()}
				disabled={!editor.draft.trim() || editor.mutation !== 'idle' || editor.mutationBlocked || isPromptRefinementPending}
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
