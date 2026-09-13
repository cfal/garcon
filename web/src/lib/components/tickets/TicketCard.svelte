<script lang="ts">
	import type { TicketStatus, TicketSummary } from '$shared/tickets';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Link2 from '@lucide/svelte/icons/link-2';
	import TicketStatusMenu from './TicketStatusMenu.svelte';
	import { ticketPriorityLabel, isTicketProjectPath } from './ticket-presentation.js';
	import { ticketDraggable } from './ticket-drag.js';
	import * as m from '$lib/paraglide/messages.js';
	let {
		ticket,
		board = false,
		selected,
		showProject,
		pending = false,
		onOpen,
		onStatus,
	}: {
		ticket: TicketSummary;
		board?: boolean;
		selected: boolean;
		showProject: boolean;
		pending?: boolean;
		onOpen: (ticket: TicketSummary) => void;
		onStatus: (ticket: TicketSummary, status: TicketStatus) => void;
	} = $props();
</script>

<article
	class:ticket-card={board}
	class:ticket-row={!board}
	class:ticket-selected={selected}
	data-ticket-id={ticket.id}
	aria-busy={pending}
	use:ticketDraggable={{ getTicket: () => ticket, canDrag: () => !pending }}
>
	{#if board}<button
			type="button"
			class="ticket-drag"
			data-ticket-drag
			aria-label={m.tickets_drag()}
			title={m.tickets_drag()}
			tabindex="-1"><GripVertical size={14} /></button
		>{/if}
	<button
		type="button"
		class="ticket-open"
		aria-label={m.tickets_open_ticket({ id: ticket.id })}
		onclick={() => onOpen(ticket)}
		data-ticket-focus={JSON.stringify({ kind: 'ticket', ticketId: ticket.id, control: 'open' })}
	>
		<span class="ticket-id">{ticket.id}</span><span class="ticket-row-title">{ticket.title}</span>
		{#if showProject}<span
				class="ticket-project"
				data-path={isTicketProjectPath(ticket.project)}
				title={ticket.project}>{ticket.project}</span
			>{/if}
	</button>
	<div class="ticket-card-meta">
		<span class="ticket-priority" data-priority={ticket.priority}
			>{ticketPriorityLabel(ticket.priority)}</span
		>
		<TicketStatusMenu {ticket} disabled={pending} onStatus={(status) => onStatus(ticket, status)} />
		{#if ticket.blockedByCount}<span class="ticket-indicator" title={m.tickets_blocked_by()}
				><Link2 size={12} />{ticket.blockedByCount}</span
			>{/if}
		{#if ticket.commentCount}<span class="ticket-indicator" title={m.tickets_comments()}
				><MessageSquare size={12} />{ticket.commentCount}</span
			>{/if}
		<span
			class="ticket-owner"
			title={ticket.assignee?.kind === 'chat' ? ticket.assignee.chatId : ticket.assignee?.username}
			>{ticket.assignee?.kind === 'chat'
				? m.tickets_chat({ id: `…${ticket.assignee.chatId.slice(-4)}` })
				: (ticket.assignee?.username ?? m.tickets_unassigned())}</span
		>
	</div>
</article>
