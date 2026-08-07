<script lang="ts">
	import type { FileTreeEntry } from '$shared/file-contracts';
	import type { FileTableRow } from '$lib/files/tree/file-tree-rows.js';
	import { buildFileTreeRenderModel } from '$lib/files/tree/file-tree-render-rows.js';
	import type { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
	import { isImageFilePath } from '$lib/utils/file-kind.js';
	import { errorMessage } from '$lib/utils/error-message.js';
	import * as m from '$lib/paraglide/messages.js';
	import FileTreeColumnHeader from './FileTreeColumnHeader.svelte';
	import FileTreeDetailsHeader from './FileTreeDetailsHeader.svelte';
	import FileTreeRenderRow from './FileTreeRenderRow.svelte';
	import { FileTreeVirtualController } from './FileTreeVirtualController.svelte.js';
	import {
		createFileTreeViewProfile,
		fileTreeViewGeometry,
		type FileTreeViewMode,
	} from './file-tree-view-profile.js';
	import { nativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';

	let {
		store,
		viewMode,
		selectedPath = null,
		onFileSelect,
		onImageSelect,
	}: {
		store: FileTreeStore;
		viewMode: FileTreeViewMode;
		selectedPath?: string | null;
		onFileSelect: (entry: FileTreeEntry) => void;
		onImageSelect?: (entry: FileTreeEntry) => void;
	} = $props();

	let viewportRef = $state<HTMLElement | null>(null);
	let semanticRows = $derived(store.filteredRows);
	let model = $derived(
		buildFileTreeRenderModel({
			rows: semanticRows,
			parentPath: store.parentPath,
			expandedDirectories: store.expandedDirs,
			loadingDirectories: store.loadingDirs,
			childErrors: store.childErrors,
		}),
	);
	let orderingModeKey = $derived(
		JSON.stringify([
			store.filterInput,
			store.sortKey,
			store.sortDirection,
			store.foldersFirst,
			store.showHiddenFiles,
		]),
	);
	let profile = $derived(
		createFileTreeViewProfile({
			mode: viewMode,
			visibleColumnKeys: store.visibleColumnKeys,
			columnGridTemplate: store.columnGridTemplate,
		}),
	);
	let geometry = $derived(fileTreeViewGeometry(viewMode));
	let tableMinimumWidth = $derived(`min(${profile.minimumTableWidthPx}px, 100%)`);

	function activateEntry(row: FileTableRow): void {
		if (row.entry.type === 'directory') {
			void store.enterDirectory(row.entry);
		} else if (isImageFilePath(row.entry.name)) {
			onImageSelect?.(row.entry);
		} else {
			onFileSelect(row.entry);
		}
	}

	const controller = new FileTreeVirtualController({
		get model() {
			return model;
		},
		get orderingModeKey() {
			return orderingModeKey;
		},
		get viewport() {
			return viewportRef;
		},
		get store() {
			return store;
		},
		get geometry() {
			return geometry;
		},
		activateEntry,
	});
	const interaction = controller.interaction;
	const virtualizer = controller.virtualizer;
	const measureVirtualRow = controller.measureVirtualRow;
	const primaryScrollRegion = nativeWorkspaceScrollRegion('primary');
	let activeFocusKey = $derived(controller.activeFocusKey);
	let virtualItems = $derived($virtualizer.getVirtualItems());
	let totalHeight = $derived($virtualizer.getTotalSize());
</script>

<div
	bind:this={viewportRef}
	{@attach primaryScrollRegion}
	role="treegrid"
	aria-label={`${m.filetree_project_files()}: ${store.currentDirectoryLabel}`}
	aria-rowcount={model.rows.length + 1}
	aria-colcount={profile.accessibleColumnCount}
	aria-busy={store.isRefreshing}
	class="file-tree-virtual-grid min-h-0 flex-1 overflow-auto overscroll-none"
	style:overflow-anchor="none"
	style:--file-tree-row-height={`${controller.rowHeight}px`}
	style:--file-tree-disclosure-size={`${controller.disclosureSize}px`}
	style:--file-tree-entry-icon-size={`${profile.entryIconSizePx}px`}
	data-file-tree-grid
>
	<div role="presentation" style:min-width={tableMinimumWidth}>
		{#if profile.mode === 'columns'}
			<FileTreeColumnHeader {store} ariaRowIndex={1} />
		{:else}
			<FileTreeDetailsHeader
				sortKey={store.sortKey}
				sortDirection={store.sortDirection}
				ariaRowIndex={1}
			/>
		{/if}
		{#if model.rows.length > 0}
			<div
				role="presentation"
				class="relative w-full overflow-clip"
				style:height={`${totalHeight}px`}
			>
				{#each virtualItems as virtualItem (virtualItem.key)}
					{@const row = model.rows[virtualItem.index]}
					{#if row}
						<div
							role="presentation"
							data-index={virtualItem.index}
							data-file-tree-virtual-row
							use:measureVirtualRow
							class="absolute left-0 top-0 w-full"
							style:transform={`translateY(${controller.getVirtualRowOffset(virtualItem.index)}px)`}
						>
							<svelte:boundary>
								<FileTreeRenderRow
									{row}
									{store}
									{profile}
									ariaRowIndex={virtualItem.index + 2}
									focused={activeFocusKey === row.key}
									selected={row.kind === 'entry' && selectedPath === row.entry.path}
									onActivate={() => interaction.activateRow(row)}
									onFocus={() => interaction.setFocusedKey(row.key)}
									onKeydown={(event) => interaction.handleRowKeydown(event, row)}
								/>
								{#snippet failed(error)}
									<div
										role="row"
										aria-rowindex={virtualItem.index + 2}
										aria-level={row.level}
										class="file-tree-virtual-row-content grid items-center overflow-hidden px-3 text-xs text-destructive"
										style={`grid-template-columns: ${profile.gridTemplate}`}
									>
										<div role="gridcell" class="truncate">
											{row.kind === 'entry' ? `${row.entry.name}: ` : ''}{errorMessage(error)}
										</div>
									</div>
								{/snippet}
							</svelte:boundary>
						</div>
					{/if}
				{/each}
			</div>
		{/if}

		{#if semanticRows.length === 0 && !store.filterInput}
			<div class="px-4 py-10 text-center">
				<h3 class="text-sm font-medium text-foreground">{m.filetree_no_files_found()}</h3>
			</div>
		{:else if semanticRows.length === 0}
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

<style>
	.file-tree-virtual-grid :global(.file-tree-virtual-row-content) {
		height: var(--file-tree-row-height);
		min-height: var(--file-tree-row-height);
	}

	.file-tree-virtual-grid :global(.file-tree-disclosure-slot) {
		height: var(--file-tree-disclosure-size);
		width: var(--file-tree-disclosure-size);
	}

	.file-tree-virtual-grid :global(.file-tree-entry-icon) {
		height: var(--file-tree-entry-icon-size);
		width: var(--file-tree-entry-icon-size);
	}
</style>
