<script lang="ts">
	import Settings from '@lucide/svelte/icons/settings';
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuCheckboxItem,
		DropdownMenuSeparator,
	} from '$lib/components/ui/dropdown-menu';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	let { controller }: { controller: IssuesController } = $props();
</script>

<DropdownMenu>
	<DropdownMenuTrigger
		class="issue-button issue-icon-button"
		aria-label={m.issues_view_settings()}
		title={m.issues_view_settings()}
	>
		<Settings size={16} />
	</DropdownMenuTrigger>
	<DropdownMenuContent align="end">
		<DropdownMenuCheckboxItem
			checked={controller.layout === 'list'}
			onCheckedChange={() => controller.setLayout('list')}
		>
			{m.issues_list()}
		</DropdownMenuCheckboxItem>
		<DropdownMenuCheckboxItem
			checked={controller.layout === 'board'}
			onCheckedChange={() => controller.setLayout('board')}
		>
			{m.issues_board()}
		</DropdownMenuCheckboxItem>
		<DropdownMenuSeparator />
		<DropdownMenuCheckboxItem
			checked={controller.detailFullWidth}
			onCheckedChange={(value) => controller.setDetailFullWidth(value)}
		>
			{m.issues_detail_full_width()}
		</DropdownMenuCheckboxItem>
	</DropdownMenuContent>
</DropdownMenu>
