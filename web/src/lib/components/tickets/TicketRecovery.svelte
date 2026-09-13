<script lang="ts">
	import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
	import { copyToClipboard } from '$lib/utils/clipboard.js';
	import TicketDraftFeedback from './TicketDraftFeedback.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let { controller }: { controller: TicketsController } = $props();
	let message = $state('');
	const retained = $derived(
		controller.drafts.active.filter((draft) => draft.needsExitGuard && !draft.pending),
	);
	const unreadable = $derived(controller.drafts.entries.filter((entry) => !entry.draft));
	const memoryOnly = $derived(
		controller.drafts.oldStoreDrafts.filter(
			(draft) =>
				!controller.drafts.oldEntries.some(
					({ entry }) =>
						entry.draft?.id === draft.current.id && entry.draft.storeId === draft.current.storeId,
				),
		),
	);
	const count = $derived(
		retained.length + unreadable.length + controller.drafts.oldEntries.length + memoryOnly.length,
	);
	async function copy(text: string) {
		message = (await copyToClipboard(text)) ? m.tickets_copied() : m.tickets_copy_failed();
	}
</script>

{#if controller.drafts.warning}<p class="ticket-notice" role="alert">
		{controller.drafts.warning}
	</p>{/if}
{#if count}
	<details class="ticket-recovery">
		<summary>{m.tickets_recovery()} · {count}</summary>
		<p class="ticket-muted">{m.tickets_recovery_hint()}</p>
		{#each retained as draft (draft.current.id)}<div class="ticket-recovery-entry">
				<strong>{draft.current.ticketId ?? m.tickets_new()} · {draft.current.kind}</strong><button
					type="button"
					class="ticket-text-button"
					onclick={() => controller.openDraft(draft)}>{m.tickets_recovery_open()}</button
				>
				<button
					type="button"
					class="ticket-text-button"
					onclick={() => void copy(JSON.stringify(draft.current, null, 2))}
					>{m.tickets_copy()}</button
				>
				<button
					type="button"
					class="ticket-text-button"
					disabled={draft.pending}
					onclick={() => draft.discard()}>{m.tickets_discard()}</button
				>
				<TicketDraftFeedback {draft} />
			</div>{/each}
		{#each unreadable as entry (entry.key)}<div class="ticket-recovery-entry">
				<strong>{m.tickets_unreadable()}</strong><button
					class="ticket-text-button"
					onclick={() => void copy(entry.raw)}>{m.tickets_copy_raw()}</button
				><button class="ticket-text-button" onclick={() => controller.drafts.discardEntry(entry)}
					>{m.tickets_discard()}</button
				>
			</div>{/each}
		{#each controller.drafts.oldEntries as { partition, entry } (entry.key)}<div
				class="ticket-recovery-entry"
			>
				<p>{m.tickets_old_store()} · {entry.draft?.ticketId ?? m.tickets_new()}</p>
				<button class="ticket-button" onclick={() => void copy(entry.raw)}
					>{m.tickets_copy_raw()}</button
				>
				<button
					class="ticket-button"
					onclick={() => controller.drafts.discardOldEntry(partition, entry)}
					>{m.tickets_discard()}</button
				>
			</div>{/each}
		{#each memoryOnly as draft (`${draft.current.storeId}:${draft.current.id}`)}<div
				class="ticket-recovery-entry"
			>
				<p>{m.tickets_old_store()}</p>
				<button
					class="ticket-button"
					onclick={() => void copy(JSON.stringify(draft.current, null, 2))}
					>{m.tickets_copy()}</button
				>
				<button class="ticket-button" disabled={draft.pending} onclick={() => draft.discard()}
					>{m.tickets_discard()}</button
				>
				<TicketDraftFeedback {draft} />
			</div>{/each}
		{#if message}<p role="status">{message}</p>{/if}
	</details>
{/if}
