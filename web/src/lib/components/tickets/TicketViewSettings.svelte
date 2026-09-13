<script lang="ts">
	import Settings from '@lucide/svelte/icons/settings';
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuCheckboxItem,
		DropdownMenuSeparator,
	} from '$lib/components/ui/dropdown-menu';
	import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	let { controller }: { controller: TicketsController } = $props();
</script>

<DropdownMenu>
	<DropdownMenuTrigger
		class="ticket-button ticket-icon-button"
		aria-label={m.tickets_view_settings()}
		title={m.tickets_view_settings()}
	>
		<Settings size={16} />
	</DropdownMenuTrigger>
	<DropdownMenuContent align="end">
		<DropdownMenuCheckboxItem
			checked={controller.layout === 'list'}
			onCheckedChange={() => controller.setLayout('list')}
		>
			{m.tickets_list()}
		</DropdownMenuCheckboxItem>
		<DropdownMenuCheckboxItem
			checked={controller.layout === 'board'}
			onCheckedChange={() => controller.setLayout('board')}
		>
			{m.tickets_board()}
		</DropdownMenuCheckboxItem>
		<DropdownMenuSeparator />
		<DropdownMenuCheckboxItem
			checked={controller.detailFullWidth}
			onCheckedChange={(value) => controller.setDetailFullWidth(value)}
		>
			{m.tickets_detail_full_width()}
		</DropdownMenuCheckboxItem>
	</DropdownMenuContent>
</DropdownMenu>
