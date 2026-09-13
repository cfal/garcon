<script lang="ts">
	import type { TicketDraftState } from '$lib/tickets/drafts/ticket-draft-state.svelte.js';
	import { ticketEditorFields } from '$lib/tickets/commands/ticket-form.js';
	import { copyToClipboard } from '$lib/utils/clipboard.js';
	import * as m from '$lib/paraglide/messages.js';
	let { draft }: { draft: TicketDraftState } = $props();
	let copyMessage = $state('');
	const current = $derived(draft.conflict?.comment ?? draft.conflict?.ticket);
	async function copy() {
		copyMessage = (await copyToClipboard(JSON.stringify(draft.current, null, 2)))
			? m.tickets_copied()
			: m.tickets_copy_failed();
	}
	function reload() {
		const conflict = draft.conflict;
		if (!conflict) return;
		draft.discard();
		if (conflict.comment)
			draft.beginEditing({ body: conflict.comment.body ?? '' }, conflict.comment.revision);
		else if (conflict.ticket?.id === draft.current.ticketId)
			draft.beginEditing(
				draft.current.kind === 'close'
					? { resolution: conflict.ticket.resolution ?? 'done', body: '' }
					: ticketEditorFields(conflict.ticket),
				conflict.ticket.revision,
			);
	}
</script>

{#if draft.error || draft.recoveryWarning || draft.current.frozen}
	<div class="ticket-notice" role="status">
		{#if draft.error}<p>{draft.error}</p>{/if}
		{#if draft.recoveryWarning}<p>{draft.recoveryWarning}</p>{/if}
		{#if current}
			<details>
				<summary>{m.tickets_server_version()}</summary>
				<pre class="ticket-conflict">{JSON.stringify(current, null, 2)}</pre>
			</details>
			{#if draft.current.kind !== 'mutation' && current.id === (draft.current.commentId ?? draft.current.ticketId)}
				<button
					type="button"
					class="ticket-button"
					onclick={() => draft.reviewRevision(current.revision)}
					disabled={!draft.canEdit}>{m.tickets_review()}</button
				>
				<button type="button" class="ticket-button" onclick={reload} disabled={!draft.canEdit}
					>{m.tickets_reload_version()}</button
				>
			{/if}
		{/if}
		<div class="ticket-actions">
			{#if draft.canRetry}<button
					type="button"
					class="ticket-button"
					onclick={() => void draft.retry()}>{m.tickets_retry_same()}</button
				>{/if}
			<button type="button" class="ticket-button" onclick={() => void copy()}
				>{m.tickets_copy()}</button
			>
			<button
				type="button"
				class="ticket-button"
				disabled={draft.pending}
				onclick={() => draft.discard()}>{m.tickets_discard()}</button
			>
		</div>
		{#if copyMessage}<p>{copyMessage}</p>{/if}
	</div>
{/if}
