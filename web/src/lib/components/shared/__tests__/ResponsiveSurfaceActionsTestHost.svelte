<script lang="ts">
	import FolderRoot from '@lucide/svelte/icons/folder-root';
	import Search from '@lucide/svelte/icons/search';
	import ResponsiveSurfaceActions, {
		type ResponsiveSurfaceAction,
	} from '../ResponsiveSurfaceActions.svelte';

	const actions: ResponsiveSurfaceAction[] = [
		{
			id: 'filter',
			label: 'Filter files',
			icon: Search,
			onclick: () => {},
			priority: 0,
			showLabel: true,
		},
		{
			id: 'project',
			label: 'Go to chat project',
			icon: FolderRoot,
			onclick: () => {},
			priority: 1,
			showLabel: true,
		},
	];
</script>

{#snippet menu(overflowActions: readonly ResponsiveSurfaceAction[])}
	{#each overflowActions as action (action.id)}
		<span data-overflow-action={action.id}>{action.label}</span>
	{/each}
	<span>Preferences</span>
{/snippet}

<ResponsiveSurfaceActions {actions} menuLabel="File browser actions" menuContent={menu} />
