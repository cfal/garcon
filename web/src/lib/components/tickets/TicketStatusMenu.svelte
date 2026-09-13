<script lang="ts">
	import { TICKET_STATUSES, type TicketStatus, type TicketSummary } from '$shared/tickets';
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuItem,
	} from '$lib/components/ui/dropdown-menu';
	import { ticketStatusLabel } from './ticket-presentation.js';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import * as m from '$lib/paraglide/messages.js';
	let {
		ticket,
		disabled = false,
		variant = 'badge',
		onStatus,
	}: {
		ticket: Pick<TicketSummary, 'id' | 'status' | 'resolution'>;
		disabled?: boolean;
		variant?: 'badge' | 'button';
		onStatus: (status: TicketStatus) => void;
	} = $props();
	let trigger = $state<HTMLElement | null>(null);
	const statusLabel = $derived.by(() => {
		if (ticket.status !== 'closed') return ticketStatusLabel(ticket.status);
		return ticket.resolution === 'canceled' ? m.tickets_canceled() : m.tickets_done();
	});
	function optionLabel(status: TicketStatus) {
		if (ticket.status === 'closed') return m.tickets_reopen();
		if (status === 'closed') return m.tickets_close();
		return ticketStatusLabel(status);
	}
</script>

<DropdownMenu>
	<DropdownMenuTrigger
		bind:ref={trigger}
		class={variant === 'button' ? 'ticket-button ticket-status-button' : 'ticket-status'}
		data-status={ticket.status}
		{disabled}
		data-ticket-focus={JSON.stringify({ kind: 'ticket', ticketId: ticket.id, control: 'status' })}
		aria-label={m.tickets_status_for({ id: ticket.id })}
	>
		<span class="ticket-status-dot" aria-hidden="true"></span>{statusLabel}
		{#if variant === 'button'}<ChevronDown size={14} aria-hidden="true" />{/if}
	</DropdownMenuTrigger>
	<DropdownMenuContent
		align="end"
		data-ticket-dialog-owner={trigger?.closest<HTMLElement>('[data-tickets-panel]')?.dataset
			.ticketsPanel}
		data-ticket-focus={JSON.stringify({ kind: 'ticket', ticketId: ticket.id, control: 'status' })}
	>
		{#each TICKET_STATUSES as status (status)}
			{#if ticket.status !== 'closed' || status === 'open'}<DropdownMenuItem
					disabled={ticket.status === status}
					onSelect={() => onStatus(status)}>{optionLabel(status)}</DropdownMenuItem
				>{/if}
		{/each}
	</DropdownMenuContent>
</DropdownMenu>
