<script lang="ts">
	import { untrack } from 'svelte';
	import AlertCircle from '@lucide/svelte/icons/alert-circle';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderUp from '@lucide/svelte/icons/folder-up';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import X from '@lucide/svelte/icons/x';
	import type { FileTreeEntry } from '$shared/file-contracts';
	import {
		FILE_TREE_PARENT_ROW_KEY,
		type FileTreeStore,
	} from '$lib/files/tree/file-tree.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import FileTreeBreadcrumbs from './FileTreeBreadcrumbs.svelte';
	import FileTreeChildRow from './FileTreeChildRow.svelte';
	import FileTreeColumnHeader from './FileTreeColumnHeader.svelte';
	import FileTreeRow from './FileTreeRow.svelte';
	import FileTreeToolbar from './FileTreeToolbar.svelte';
	import { FileTreeInteractionState } from './FileTreeInteractionState.svelte.js';

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

	let treegrid = $state<HTMLElement | null>(null);
	const rows = $derived(store.filteredRows);
	const navigableRows = $derived.by(() => {
		const items: Array<{ key: string; level: number }> = store.parentPath
			? [{ key: FILE_TREE_PARENT_ROW_KEY, level: 1 }]
			: [];
		for (const row of rows) {
			items.push({ key: row.key, level: row.level });
			if (
				row.entry.type === 'directory' &&
				store.expandedDirs.has(row.entry.path) &&
				store.childErrors.has(row.entry.path)
			) {
				items.push({ key: childErrorRowKey(row.key), level: row.level + 1 });
			}
		}
		return items;
	});
	const rowKeys = $derived(navigableRows.map((row) => row.key));
	const rowLevels = $derived(new Map(navigableRows.map((row) => [row.key, row.level])));
	const minimumTableWidth = $derived(store.visibleColumnKeys.length === 1 ? '240px' : '520px');
	const interaction = new FileTreeInteractionState({
		get rowKeys() {
			return rowKeys;
		},
		get rows() {
			return rows;
		},
		get rowLevels() {
			return rowLevels;
		},
		get treegrid() {
			return treegrid;
		},
		get store() {
			return store;
		},
		activateEntry: (row) => activateEntry(row.entry),
	});
	const activeFocusKey = $derived(interaction.activeFocusKey);

	function childErrorRowKey(parentKey: string): string {
		return `file-tree-child-error:${parentKey}`;
	}

	function isImageFile(filename: string): boolean {
		const extension = filename.split('.').pop()?.toLowerCase() ?? '';
		return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(extension);
	}

	function errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function activateEntry(entry: FileTreeEntry): void {
		if (entry.type === 'directory') {
			void store.enterDirectory(entry);
			return;
		}
		if (isImageFile(entry.name)) onImageSelect?.(entry);
		else onFileSelect(entry);
	}

	$effect(() => {
		const focusPath = store.focusPathAfterNavigation;
		store.currentDirectoryPath;
		if (!focusPath || !treegrid) return;
		untrack(() => {
			interaction.focusRow(focusPath);
			store.consumeFocusPathAfterNavigation();
		});
	});
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
		<div
			bind:this={treegrid}
			role="treegrid"
			aria-label={`${m.filetree_project_files()}: ${store.currentDirectoryLabel}`}
			aria-colcount={store.visibleColumnKeys.length}
			class="min-h-0 flex-1 overflow-auto overscroll-contain"
			data-file-tree-grid
		>
			<div style={`min-width: ${minimumTableWidth}`}>
				<FileTreeColumnHeader {store} />
				{#if store.parentPath}
					<div
						role="row"
						tabindex={activeFocusKey === FILE_TREE_PARENT_ROW_KEY ? 0 : -1}
						aria-level="1"
						data-file-tree-row
						data-file-tree-row-key={FILE_TREE_PARENT_ROW_KEY}
						data-file-tree-parent-row
						class="grid min-h-8 cursor-default select-none items-center gap-2 px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
						style={`grid-template-columns: ${store.columnGridTemplate}`}
						onclick={() => void store.goToParent()}
						onfocus={() => interaction.setFocusedKey(FILE_TREE_PARENT_ROW_KEY)}
						onkeydown={(event) => interaction.handleParentKeydown(event)}
					>
						<div role="rowheader" class="flex min-w-0 items-center" title={store.parentPath}>
							<span class="h-7 w-7 shrink-0" aria-hidden="true"></span>
							<FolderUp class="mr-2 h-4 w-4 shrink-0 text-file-icon-folder" />
							<span class="truncate">..</span>
							<span class="sr-only">{m.filetree_parent_directory()}</span>
						</div>
						{#each store.visibleColumnKeys.slice(1) as column (column)}
							<div role="gridcell" aria-label={column}></div>
						{/each}
					</div>
				{/if}

				{#each rows as row (row.key)}
					<svelte:boundary>
						<FileTreeRow
							{row}
							{store}
							focused={activeFocusKey === row.key}
							selected={selectedPath === row.entry.path}
							onActivate={() => activateEntry(row.entry)}
							onFocus={() => interaction.setFocusedKey(row.key)}
							onKeydown={(event) => interaction.handleEntryKeydown(event, row)}
						/>
						{#if row.entry.type === 'directory' && store.expandedDirs.has(row.entry.path)}
							{#if store.loadingDirs.has(row.entry.path)}
								<FileTreeChildRow
									kind="loading"
									level={row.level + 1}
									directoryName={row.entry.name}
									columnGridTemplate={store.columnGridTemplate}
									visibleColumnKeys={store.visibleColumnKeys}
								/>
							{:else if store.childErrors.has(row.entry.path)}
								{@const errorKey = childErrorRowKey(row.key)}
								<FileTreeChildRow
									kind="error"
									rowKey={errorKey}
									level={row.level + 1}
									directoryName={row.entry.name}
									columnGridTemplate={store.columnGridTemplate}
									visibleColumnKeys={store.visibleColumnKeys}
									focused={activeFocusKey === errorKey}
									onFocus={() => interaction.setFocusedKey(errorKey)}
									onRetry={() => store.retryDirectory(row.entry.path)}
									onKeydown={(event) =>
										interaction.handleChildErrorKeydown(event, errorKey, row.key, () =>
											store.retryDirectory(row.entry.path),
										)}
								/>
							{/if}
						{/if}
						{#snippet failed(error)}
							<div role="row" class="px-3 py-2 text-xs text-destructive">
								<div role="gridcell">{row.entry.name}: {errorMessage(error)}</div>
							</div>
						{/snippet}
					</svelte:boundary>
				{/each}

				{#if rows.length === 0 && !store.filterInput}
					<div class="px-4 py-10 text-center">
						<Folder class="mx-auto h-7 w-7 text-muted-foreground" />
						<h3 class="mt-2 text-sm font-medium text-foreground">{m.filetree_no_files_found()}</h3>
					</div>
				{:else if rows.length === 0 && store.filterInput}
					<div class="px-4 py-10 text-center">
						<h3 class="text-sm font-medium text-foreground">{m.filetree_no_matching_rows()}</h3>
						<button
							type="button"
							class="mt-3 inline-flex h-8 items-center rounded-md border border-border px-3 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
							onclick={() => store.clearFilter()}
						>
							{m.filetree_clear_filter()}
						</button>
					</div>
				{/if}
			</div>
		</div>
	{:else}
		<div class="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
			{m.filetree_no_files_found()}
		</div>
	{/if}
</div>
