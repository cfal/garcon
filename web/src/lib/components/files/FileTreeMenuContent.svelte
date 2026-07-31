<script lang="ts">
	import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
	import Columns3 from '@lucide/svelte/icons/columns-3';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Rows3 from '@lucide/svelte/icons/rows-3';
	import {
		DropdownMenuCheckboxItem,
		DropdownMenuItem,
		DropdownMenuLabel,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
		DropdownMenuSeparator,
	} from '$lib/components/ui/dropdown-menu';
	import type { ResponsiveSurfaceAction } from '$lib/components/shared/ResponsiveSurfaceActions.svelte';
	import type { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import { fileTreeFieldLabel } from './file-tree-entry-presentation.js';
	import type { FileTreeViewMode } from './file-tree-view-profile.js';

	let {
		overflowActions,
		store,
		viewMode,
	}: {
		overflowActions: readonly ResponsiveSurfaceAction[];
		store: FileTreeStore;
		viewMode: FileTreeViewMode;
	} = $props();
</script>

{#each overflowActions as action (action.id)}
	{@const Icon = action.icon}
	<DropdownMenuItem
		disabled={action.disabled || action.busy}
		aria-busy={action.busy || undefined}
		onclick={action.onclick}
	>
		<Icon class={cn('h-4 w-4', action.iconClass)} />
		<span class="min-w-0 truncate">{action.label}</span>
	</DropdownMenuItem>
{/each}
{#if overflowActions.length > 0}
	<DropdownMenuSeparator />
{/if}
<DropdownMenuCheckboxItem
	checked={store.foldersFirst}
	onCheckedChange={(checked) => store.setFoldersFirst(Boolean(checked))}
>
	{m.filetree_settings_folders_first()}
</DropdownMenuCheckboxItem>
<DropdownMenuCheckboxItem
	checked={store.showHiddenFiles}
	onCheckedChange={(checked) => store.setShowHiddenFiles(Boolean(checked))}
>
	{m.filetree_settings_show_hidden_files()}
</DropdownMenuCheckboxItem>
<DropdownMenuCheckboxItem
	checked={store.showBreadcrumbs}
	onCheckedChange={(checked) => store.setShowBreadcrumbs(Boolean(checked))}
>
	{m.filetree_show_breadcrumbs()}
</DropdownMenuCheckboxItem>
<DropdownMenuCheckboxItem
	checked={store.showIcons}
	onCheckedChange={(checked) => store.setShowIcons(Boolean(checked))}
>
	{m.filetree_show_icons()}
</DropdownMenuCheckboxItem>
<DropdownMenuCheckboxItem
	checked={store.viewPreference === 'always-details'}
	onCheckedChange={(checked) => store.setAlwaysUseDetailedRows(Boolean(checked))}
>
	{m.filetree_always_use_detailed_rows()}
</DropdownMenuCheckboxItem>
<DropdownMenuSeparator />
<DropdownMenuLabel class="flex items-center gap-2 text-xs text-muted-foreground">
	{#if viewMode === 'details'}
		<Rows3 class="h-3.5 w-3.5" />
		{m.filetree_details()}
	{:else}
		<Columns3 class="h-3.5 w-3.5" />
		{m.filetree_columns()}
	{/if}
</DropdownMenuLabel>
<DropdownMenuCheckboxItem
	checked={store.visibleColumns.size}
	onCheckedChange={(checked) => store.setColumnVisible('size', Boolean(checked))}
>
	{m.filetree_size()}
</DropdownMenuCheckboxItem>
<DropdownMenuCheckboxItem
	checked={store.visibleColumns.modified}
	onCheckedChange={(checked) => store.setColumnVisible('modified', Boolean(checked))}
>
	{m.filetree_modified()}
</DropdownMenuCheckboxItem>
<DropdownMenuCheckboxItem
	checked={store.visibleColumns.permissions}
	onCheckedChange={(checked) => store.setColumnVisible('permissions', Boolean(checked))}
>
	{m.filetree_permissions()}
</DropdownMenuCheckboxItem>
<DropdownMenuSeparator />
{#if viewMode === 'columns'}
	<DropdownMenuItem onclick={() => store.resetColumnWidths()}>
		<RotateCcw class="h-4 w-4" />
		{m.filetree_reset_column_widths()}
	</DropdownMenuItem>
{:else}
	<DropdownMenuLabel class="flex items-center gap-2 text-xs text-muted-foreground">
		<ArrowUpDown class="h-3.5 w-3.5" />
		{m.filetree_sort_by()}
	</DropdownMenuLabel>
	<DropdownMenuRadioGroup
		value={store.sortKey}
		onValueChange={(value) => store.selectSortKey(value)}
	>
		{#each store.visibleColumnKeys as key (key)}
			<DropdownMenuRadioItem value={key} closeOnSelect={false}>
				{fileTreeFieldLabel(key)}
			</DropdownMenuRadioItem>
		{/each}
	</DropdownMenuRadioGroup>
	<DropdownMenuLabel class="text-xs text-muted-foreground">
		{m.filetree_sort_direction()}
	</DropdownMenuLabel>
	<DropdownMenuRadioGroup
		value={store.sortDirection}
		onValueChange={(value) => {
			if (value === 'asc' || value === 'desc') store.setSortDirection(value);
		}}
	>
		<DropdownMenuRadioItem value="asc" closeOnSelect={false}>
			{m.filetree_sort_ascending()}
		</DropdownMenuRadioItem>
		<DropdownMenuRadioItem value="desc" closeOnSelect={false}>
			{m.filetree_sort_descending()}
		</DropdownMenuRadioItem>
	</DropdownMenuRadioGroup>
{/if}
