<script lang="ts">
	import FolderRoot from '@lucide/svelte/icons/folder-root';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import Input from '$lib/components/ui/input/input.svelte';
	import ResponsiveSurfaceActions, {
		type ResponsiveSurfaceAction,
	} from '$lib/components/shared/ResponsiveSurfaceActions.svelte';
	import type { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import FileTreeMenuContent from './FileTreeMenuContent.svelte';

	let { store }: { store: FileTreeStore } = $props();
	let root = $state<HTMLElement | null>(null);
	let filterInput = $state<HTMLInputElement | null>(null);

	function restoreToolbarFocus(): void {
		queueMicrotask(() => {
			const target =
				root?.querySelector<HTMLElement>('[data-surface-action-id="filter-files"]') ??
				root?.querySelector<HTMLElement>('[data-responsive-surface-menu-trigger]');
			target?.focus();
		});
	}

	function toggleFilter(): void {
		if (store.filterOpen) {
			store.closeFilter();
			restoreToolbarFocus();
			return;
		}
		store.openFilter();
	}

	const actions = $derived.by<ResponsiveSurfaceAction[]>(() => [
		{
			id: 'filter-files',
			label: store.filterOpen ? m.filetree_close_filter() : m.filetree_filter_files(),
			icon: Search,
			onclick: toggleFilter,
			disabled: store.navigation.kind !== 'ready',
			priority: 0,
			showLabel: true,
		},
		{
			id: 'chat-project',
			label: m.filetree_go_to_chat_project(),
			title: store.isAtChatProject
				? m.filetree_already_at_chat_project()
				: m.filetree_go_to_chat_project(),
			icon: FolderRoot,
			onclick: () => void store.goToChatProject(),
			disabled: store.isAtChatProject || store.isNavigationLoading,
			priority: 1,
			showLabel: true,
		},
	]);

	$effect(() => {
		if (!store.filterOpen || !filterInput) return;
		queueMicrotask(() => filterInput?.focus());
	});
</script>

{#snippet fileMenu(overflowActions: readonly ResponsiveSurfaceAction[])}
	<FileTreeMenuContent {overflowActions} {store} />
{/snippet}

<div bind:this={root} class="shrink-0 border-b border-border bg-card" data-file-tree-toolbar>
	<div
		role="toolbar"
		aria-label={m.filetree_actions()}
		class="flex min-h-11 min-w-0 items-center px-2 py-1.5"
	>
		<ResponsiveSurfaceActions {actions} menuLabel={m.filetree_actions()} menuContent={fileMenu} />
	</div>

	{#if store.filterOpen}
		<div class="border-t border-border px-2 py-2">
			<div class="relative">
				<Search
					class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					bind:ref={filterInput}
					type="text"
					placeholder={m.filetree_filter_placeholder()}
					bind:value={store.filterInput}
					class="h-8 pl-8 pr-8 text-sm"
					onkeydown={(event) => {
						if (event.key !== 'Escape') return;
						store.closeFilter();
						restoreToolbarFocus();
					}}
				/>
				{#if store.filterInput}
					<button
						type="button"
						class="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						onclick={() => store.clearFilter()}
						aria-label={m.filetree_clear_filter()}
						title={m.filetree_clear_filter()}
					>
						<X class="h-3.5 w-3.5" />
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>
