<script lang="ts">
	import Filter from '@lucide/svelte/icons/list-filter';
	import {
		TICKET_STATUSES,
		ticketAssigneeQuery,
		type TicketListQuery,
		type TicketPriority,
	} from '$shared/tickets';
	import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
	import {
		ticketPriorityLabel,
		ticketStatusLabel,
		type TicketChatSummary,
	} from './ticket-presentation.js';
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuCheckboxItem,
	} from '$lib/components/ui/dropdown-menu';
	import TicketFacetFilter from './TicketFacetFilter.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		chats,
		username,
		onFilter,
	}: {
		controller: TicketsController;
		chats: readonly TicketChatSummary[];
		username: string;
		onFilter: (change: Pick<TicketListQuery, 'label' | 'ready' | 'includeClosed'>) => boolean;
	} = $props();
	const labelId = $props.id();
</script>

<div class="ticket-filter-options">
	<label class="ticket-field">
		{m.tickets_status()}
		<select class="ticket-input" name="status" value={controller.query.status ?? ''}>
			<option value="">{m.tickets_all_statuses()}</option>
			{#each TICKET_STATUSES as status (status)}
				<option value={status}>{ticketStatusLabel(status)}</option>
			{/each}
		</select>
	</label>
	<label class="ticket-field">
		{m.tickets_priority()}
		<select class="ticket-input" name="priority" value={controller.query.priority ?? ''}>
			<option value="">{m.tickets_all_priorities()}</option>
			{#each [0, 1, 2, 3] as priority (priority)}
				<option value={priority}>{ticketPriorityLabel(priority as TicketPriority)}</option>
			{/each}
		</select>
	</label>
	<label class="ticket-field">
		{m.tickets_assignee()}
		<select
			class="ticket-input"
			name="assignee"
			value={controller.query.assignee ? ticketAssigneeQuery(controller.query.assignee) : ''}
		>
			<option value="">{m.tickets_any_assignee()}</option>
			<option value="unassigned">{m.tickets_unassigned()}</option>
			<option value={`user:${username}`}>{m.tickets_me()}</option>
			{#each chats as chat (chat.id)}
				<option value={`chat:${chat.id}`}>{chat.title || chat.id}</option>
			{/each}
		</select>
	</label>
	<div class="ticket-field">
		<label for={labelId}>{m.tickets_label_filter()}</label>
		<TicketFacetFilter
			id={labelId}
			{controller}
			field="label"
			onSelect={(label) => onFilter({ label })}
		/>
	</div>
	<DropdownMenu>
		<DropdownMenuTrigger
			class="ticket-button ticket-extra-filters"
			data-active={controller.query.ready || controller.query.includeClosed}
		>
			<Filter size={15} />{m.tickets_filter_menu()}
		</DropdownMenuTrigger>
		<DropdownMenuContent align="end">
			<DropdownMenuCheckboxItem
				checked={controller.query.ready ?? false}
				onCheckedChange={(ready) => onFilter({ ready })}
			>
				{m.tickets_ready()}
			</DropdownMenuCheckboxItem>
			<DropdownMenuCheckboxItem
				checked={controller.query.includeClosed ?? false}
				onCheckedChange={(includeClosed) => onFilter({ includeClosed })}
			>
				{m.tickets_include_closed()}
			</DropdownMenuCheckboxItem>
		</DropdownMenuContent>
	</DropdownMenu>
</div>
