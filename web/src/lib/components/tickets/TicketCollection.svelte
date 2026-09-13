<script lang="ts">
	import type { TicketStatus, TicketSummary } from '$shared/tickets';
	import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
	import type { TicketWindowKey } from '$lib/tickets/catalog/ticket-collection.js';
	import { ticketWindowLimit } from '$lib/tickets/catalog/ticket-collection.js';
	import TicketCard from './TicketCard.svelte';
	import { ticketStatusLabel } from './ticket-presentation.js';
	import { ticketDropTarget } from './ticket-drag.js';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		onOpen,
		onStatus,
		pinned = null,
	}: {
		controller: TicketsController;
		onOpen: (ticket: TicketSummary) => void;
		onStatus: (ticket: TicketSummary, status: TicketStatus) => void;
		pinned?: { key: TicketWindowKey; ticket: TicketSummary } | null;
	} = $props();
	const collection = $derived(controller.displayedCollection);
	function items(key: TicketWindowKey) {
		const entries = collection?.windows[key]?.items ?? [];
		if (!pinned || pinned.key !== key) return entries;
		const pinnedTicket = pinned.ticket;
		if (
			controller.mutations.busy(pinnedTicket.id) ||
			entries.some((ticket) => ticket.id === pinnedTicket.id)
		)
			return entries;
		return [pinnedTicket, ...entries.slice(0, ticketWindowLimit(key) - 1)];
	}
</script>

{#snippet cards(key: TicketWindowKey)}
	{#each items(key) as ticket (ticket.id)}
		<svelte:boundary>
			<TicketCard
				{ticket}
				board={controller.layout === 'board'}
				selected={controller.detail.selectedId === ticket.id}
				showProject={!controller.collectionQuery.project}
				pending={controller.mutations.busy(ticket.id)}
				{onOpen}
				{onStatus}
			/>
			{#snippet failed()}<p class="ticket-notice">{m.tickets_invalid_entry()}</p>{/snippet}
		</svelte:boundary>
	{/each}
	{@const page = controller.collection?.windows[key]}
	{#if page}<div class="ticket-pagination">
			{#if page.pageIndex > 0}<button
					class="ticket-button"
					disabled={!!controller.pagePending || controller.stale}
					onclick={() => void controller.page(key, 'previous')}>{m.tickets_previous()}</button
				>{/if}
			{#if page.nextBeforeNumber !== null}<button
					class="ticket-button"
					disabled={!!controller.pagePending || controller.stale}
					onclick={() =>
						void controller.page(key, page.items.length < ticketWindowLimit(key) ? 'more' : 'next')}
					>{page.items.length < ticketWindowLimit(key)
						? m.tickets_load_more()
						: m.tickets_next()}</button
				>{/if}
		</div>{/if}
{/snippet}
{#if controller.layout === 'list'}
	<div class="ticket-list" data-ticket-window="list" data-ticket-scroll="list">
		{@render cards('list')}
		{#if controller.collection}<p class="ticket-counts">
				{m.tickets_counts({
					loaded: items('list').length,
					total: Object.values(collection!.counts.counts).reduce((sum, count) => sum + count, 0),
				})}
			</p>{/if}
	</div>
{:else}
	<nav class="ticket-lane-tabs" aria-label={m.tickets_status()}>
		{#each controller.lanes as status (status)}<button
				class="ticket-button"
				aria-pressed={controller.activeLane === status}
				onclick={() => (controller.activeLane = status)}
				>{ticketStatusLabel(status)} · {collection?.counts.counts[status] ?? 0}</button
			>{/each}
	</nav>
	<div class="ticket-board">
		{#each controller.lanes as status (status)}
			<section
				class="ticket-lane"
				data-status={status}
				data-active={controller.activeLane === status}
				data-ticket-window={status}
				use:ticketDropTarget={{ status, onDrop: onStatus }}
				aria-label={ticketStatusLabel(status)}
			>
				<h3 tabindex="-1" data-ticket-focus={JSON.stringify({ kind: 'lane', status })}>
					<span class="ticket-status-dot" aria-hidden="true"></span>{ticketStatusLabel(status)}<span
						class="ticket-counts"
						>{m.tickets_counts({
							loaded: items(status).length,
							total: collection?.counts.counts[status] ?? 0,
						})}</span
					>
				</h3>
				<div class="ticket-lane-scroll" data-ticket-scroll={status}>{@render cards(status)}</div>
			</section>
		{/each}
	</div>
{/if}
