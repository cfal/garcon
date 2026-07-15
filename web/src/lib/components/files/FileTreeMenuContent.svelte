<script lang="ts">
	import Columns3 from '@lucide/svelte/icons/columns-3';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import {
		DropdownMenuCheckboxItem,
		DropdownMenuItem,
		DropdownMenuLabel,
		DropdownMenuSeparator,
	} from '$lib/components/ui/dropdown-menu';
	import type { ResponsiveSurfaceAction } from '$lib/components/shared/ResponsiveSurfaceActions.svelte';
	import type { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		overflowActions,
		store,
	}: {
		overflowActions: readonly ResponsiveSurfaceAction[];
		store: FileTreeStore;
	} = $props();
</script>

{#each overflowActions as action (action.id)}
	{@const Icon = action.icon}
	<DropdownMenuItem disabled={action.disabled} onclick={action.onclick}>
		<Icon class="h-4 w-4" />
		<span class="min-w-0 truncate">{action.label}</span>
	</DropdownMenuItem>
{/each}
{#if overflowActions.length > 0}
	<DropdownMenuSeparator />
{/if}

<DropdownMenuItem
	disabled={store.isNavigationLoading || store.isRefreshing || !store.readyResponse}
	onclick={() => void store.refresh()}
>
	<RefreshCw class={`h-4 w-4 ${store.isRefreshing ? 'animate-spin' : ''}`} />
	{m.filetree_refresh_files()}
</DropdownMenuItem>
<DropdownMenuSeparator />
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
<DropdownMenuSeparator />
<DropdownMenuLabel class="flex items-center gap-2 text-xs text-muted-foreground">
	<Columns3 class="h-3.5 w-3.5" />
	{m.filetree_columns()}
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
<DropdownMenuItem onclick={() => store.resetColumnWidths()}>
	<RotateCcw class="h-4 w-4" />
	{m.filetree_reset_column_widths()}
</DropdownMenuItem>
