<script lang="ts">
	import AlertCircle from '@lucide/svelte/icons/alert-circle';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import X from '@lucide/svelte/icons/x';
	import type { FileTreeEntry } from '$shared/file-contracts';
	import type { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import FileTreeBreadcrumbs from './FileTreeBreadcrumbs.svelte';
	import FileTreeToolbar from './FileTreeToolbar.svelte';
	import FileTreeVirtualRows from './FileTreeVirtualRows.svelte';

	let {
		store,
		selectedPath = null,
		onFileSelect,
		onImageSelect,
	}: {
		store: FileTreeStore;
		selectedPath?: string | null;
		onFileSelect: (file: FileTreeEntry) => void;
		onImageSelect?: (file: FileTreeEntry) => void;
	} = $props();
</script>

<div class="flex h-full min-h-0 flex-col bg-card">
	<FileTreeToolbar {store} />
	{#if store.showBreadcrumbs && store.currentBreadcrumbs.length > 0}
		<FileTreeBreadcrumbs
			breadcrumbs={store.currentBreadcrumbs}
			onNavigate={(index) => void store.navigateToBreadcrumb(index)}
		/>
	{/if}

	{#if store.refreshError && store.navigation.kind === 'ready'}
		<div
			class="flex shrink-0 items-center gap-2 border-b border-border bg-destructive/10 px-3 py-2 text-sm text-destructive"
			role="status"
		>
			<AlertCircle class="h-4 w-4 shrink-0" />
			<span class="min-w-0 flex-1 truncate" title={store.refreshError.message}>
				{m.filetree_refresh_failed()}: {store.refreshError.message}
			</span>
			<button
				type="button"
				class="inline-flex h-7 items-center gap-1 rounded-sm px-2 hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				onclick={() => void store.refresh()}
			>
				<RotateCcw class="h-3.5 w-3.5" />
				{m.filetree_retry()}
			</button>
			<button
				type="button"
				class="inline-flex h-7 w-7 items-center justify-center rounded-sm hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				onclick={() => store.dismissRefreshError()}
				aria-label={m.filetree_dismiss()}
			>
				<X class="h-3.5 w-3.5" />
			</button>
		</div>
	{/if}

	{#if store.navigation.kind === 'loading'}
		<div
			class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
			role="status"
			data-file-tree-loading
		>
			<LoaderCircle class="h-6 w-6 animate-spin text-muted-foreground" />
			<div class="min-w-0">
				<div
					class="truncate text-sm font-medium text-foreground"
					title={store.navigation.target.path}
				>
					{m.filetree_loading_directory({ name: store.navigation.target.label })}
				</div>
			</div>
		</div>
	{:else if store.navigation.kind === 'error'}
		<div
			class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
			data-file-tree-error
		>
			<AlertCircle class="h-7 w-7 text-destructive" />
			<div class="max-w-md">
				<h3 class="text-sm font-medium text-foreground">{m.filetree_navigation_failed()}</h3>
				<p class="mt-1 text-sm text-muted-foreground">{store.navigation.error.message}</p>
			</div>
			<div class="flex items-center gap-2">
				<button
					type="button"
					class="inline-flex h-8 items-center rounded-md bg-interactive-accent px-3 text-sm text-interactive-accent-foreground hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					onclick={() => void store.retryNavigation()}
				>
					{m.filetree_retry()}
				</button>
				{#if store.navigation.previous}
					<button
						type="button"
						class="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						onclick={() => store.backFromNavigationError()}
					>
						{m.filetree_back()}
					</button>
				{/if}
			</div>
		</div>
	{:else if store.navigation.kind === 'ready'}
		<FileTreeVirtualRows {store} {selectedPath} {onFileSelect} {onImageSelect} />
	{:else}
		<div class="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
			{m.filetree_no_files_found()}
		</div>
	{/if}
</div>
