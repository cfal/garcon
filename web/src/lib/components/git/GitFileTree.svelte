<script lang="ts">
	import { onDestroy } from 'svelte';
	import Search from '@lucide/svelte/icons/search';
	import type { GitTreeNode } from '$lib/api/git.js';
	import {
		flattenGitWorkbenchTree,
		type GitWorkbenchTreeRow,
	} from '$lib/git/workbench/git-workbench-tree-rows.js';
	import * as m from '$lib/paraglide/messages.js';
	import { nativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';
	import GitFileTreeRow from './GitFileTreeRow.svelte';
	import { GitFileTreeVirtualController } from './GitFileTreeVirtualController.svelte.js';

	interface GitFileTreeProps {
		tree: GitTreeNode[];
		selectedFile: string | null;
		collapsedDirs: Set<string>;
		treeSearchQuery: string;
		totalChangedFiles: number;
		onSelectFile: (path: string) => void;
		onSelectDirectory?: (path: string) => void;
		onToggleDir: (path: string) => void;
		onSearchChange: (query: string) => void;
		onStageFile?: (path: string) => void;
		onUnstageFile?: (path: string) => void;
		onStageDir?: (path: string) => void;
		onUnstageDir?: (path: string) => void;
		onDiscardFile?: (path: string) => void;
		isStageFilePending?: (path: string) => boolean;
		isUnstageFilePending?: (path: string) => boolean;
		isStageDirPending?: (path: string) => boolean;
		isUnstageDirPending?: (path: string) => boolean;
		hideGenerated?: boolean;
		hideOtherTabFiles?: boolean;
		hideOtherTabFilesLabel?: string;
		visibleChangedFiles?: number;
		onHideGeneratedChange?: (value: boolean) => void;
		onHideOtherTabFilesChange?: (value: boolean) => void;
		alwaysShowActions?: boolean;
	}

	let {
		tree,
		selectedFile,
		collapsedDirs,
		treeSearchQuery,
		totalChangedFiles,
		onSelectFile,
		onSelectDirectory,
		onToggleDir,
		onSearchChange,
		onStageFile,
		onUnstageFile,
		onStageDir,
		onUnstageDir,
		onDiscardFile,
		isStageFilePending,
		isUnstageFilePending,
		isStageDirPending,
		isUnstageDirPending,
		hideGenerated = false,
		hideOtherTabFiles = false,
		hideOtherTabFilesLabel = m.git_file_tree_hide_staged(),
		visibleChangedFiles,
		onHideGeneratedChange,
		onHideOtherTabFilesChange,
		alwaysShowActions = false,
	}: GitFileTreeProps = $props();

	const treeId = $props.id();
	const contextualScrollRegion = nativeWorkspaceScrollRegion('contextual');
	let viewportElement = $state<HTMLDivElement | null>(null);
	let rows = $derived(flattenGitWorkbenchTree(tree, collapsedDirs));
	const actionVisibility = $derived(
		alwaysShowActions
			? 'opacity-100'
			: 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
	);
	const fileCountLabel = $derived(
		visibleChangedFiles !== undefined
			? m.git_file_tree_files_filtered_count({
					visible: visibleChangedFiles,
					total: totalChangedFiles,
				})
			: m.git_file_tree_files_count({ count: totalChangedFiles }),
	);

	const controller = new GitFileTreeVirtualController({
		get rows() {
			return rows;
		},
		get collapsedDirs() {
			return collapsedDirs;
		},
		get selectedFile() {
			return selectedFile;
		},
		get viewportElement() {
			return viewportElement;
		},
		get onSelectFile() {
			return onSelectFile;
		},
		get onToggleDir() {
			return onToggleDir;
		},
	});
	let virtualSnapshot = $derived(controller.snapshot);
	let renderedItems = $derived(controller.renderedItems(virtualSnapshot));
	let totalHeight = $derived(virtualSnapshot.sizerSize);
	let activeFocusKey = $derived(controller.activeFocusKey);
	let activeRowIndex = $derived(controller.activeRowIndex);
	let activeDescendantId = $derived(
		activeRowIndex >= 0 && renderedItems.some((item) => item.index === activeRowIndex)
			? rowElementId(activeRowIndex)
			: undefined,
	);

	function rowElementId(index: number): string {
		return `${treeId}-row-${index}`;
	}

	function isDirectory(row: GitWorkbenchTreeRow): boolean {
		return row.node.kind === 'directory';
	}

	function rowIsCollapsed(row: GitWorkbenchTreeRow): boolean {
		return isDirectory(row) && collapsedDirs.has(row.node.path);
	}

	function rowIsSelected(row: GitWorkbenchTreeRow): boolean {
		return !isDirectory(row) && selectedFile === row.node.path;
	}

	function stageIsPending(row: GitWorkbenchTreeRow): boolean {
		if (isDirectory(row)) return isStageDirPending?.(row.node.path) ?? false;
		return isStageFilePending?.(row.node.path) ?? false;
	}

	function unstageIsPending(row: GitWorkbenchTreeRow): boolean {
		if (isDirectory(row)) return isUnstageDirPending?.(row.node.path) ?? false;
		return isUnstageFilePending?.(row.node.path) ?? false;
	}

	onDestroy(() => controller.destroy());
</script>

<div class="flex h-full flex-col bg-background">
	<div class="border-b border-border px-3 py-2">
		<div class="mb-2 flex items-center justify-between gap-2">
			<span class="truncate text-xs font-medium uppercase tracking-wider text-muted-foreground">
				{fileCountLabel}
			</span>
		</div>
		<div class="relative">
			<Search class="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
			<input
				type="text"
				placeholder={m.git_filter_files_placeholder()}
				value={treeSearchQuery}
				oninput={(event) => onSearchChange(event.currentTarget.value)}
				class="w-full rounded border border-border bg-muted py-1 pl-7 pr-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			/>
		</div>
		<div class="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
			<label class="inline-flex items-center gap-1.5">
				<input
					type="checkbox"
					checked={hideOtherTabFiles}
					onchange={(event) => onHideOtherTabFilesChange?.(event.currentTarget.checked)}
					class="size-3 accent-current"
				/>
				<span>{hideOtherTabFilesLabel}</span>
			</label>
			<label class="inline-flex items-center gap-1.5">
				<input
					type="checkbox"
					checked={hideGenerated}
					onchange={(event) => onHideGeneratedChange?.(event.currentTarget.checked)}
					class="size-3 accent-current"
				/>
				<span>{m.git_file_tree_hide_generated()}</span>
			</label>
		</div>
	</div>

	<div
		bind:this={viewportElement}
		{@attach controller.viewport}
		{@attach contextualScrollRegion}
		class="min-h-0 flex-1 overflow-y-auto py-1 focus-visible:outline-none"
		style:overflow-anchor="none"
		role="tree"
		tabindex="0"
		aria-label={m.git_diff_document_files()}
		aria-activedescendant={activeDescendantId}
		data-git-workbench-file-tree
		onkeydown={(event) => controller.handleTreeKeydown(event)}
	>
		{#if rows.length === 0}
			<div class="px-3 py-4 text-center text-xs text-muted-foreground">
				{m.git_file_tree_no_changed_files()}
			</div>
		{:else}
			<div
				class="relative w-full"
				style:height={`${totalHeight}px`}
				role="none"
				data-git-workbench-file-tree-sizer
				{@attach controller.sizer}
			>
				{#each renderedItems as virtualItem (virtualItem.key)}
					{@const row = rows[virtualItem.index]}
					{#if row}
						<div
							id={rowElementId(virtualItem.index)}
							role="treeitem"
							aria-label={row.node.name}
							aria-level={row.depth + 1}
							aria-expanded={isDirectory(row) ? !rowIsCollapsed(row) : undefined}
							aria-selected={rowIsSelected(row)}
							aria-posinset={row.positionInSet}
							aria-setsize={row.setSize}
							tabindex="-1"
							class="group absolute left-0 top-0 w-full overflow-hidden focus-visible:outline-none"
							style:height={`${virtualItem.size}px`}
							style:transform={`translateY(${virtualItem.start}px)`}
							title={row.node.path}
							data-git-workbench-file-tree-row
							data-git-tree-row-key={row.key}
							data-git-tree-row-active={activeFocusKey === row.key ? '' : undefined}
							data-git-file-tree-directory={isDirectory(row) ? '' : undefined}
							data-git-file-tree-file={!isDirectory(row) ? '' : undefined}
						>
							<svelte:boundary>
								<GitFileTreeRow
									{row}
									selected={rowIsSelected(row)}
									collapsed={rowIsCollapsed(row)}
									{actionVisibility}
									stagePending={stageIsPending(row)}
									unstagePending={unstageIsPending(row)}
									onFocusRow={() => controller.setFocusedRow(row.key)}
									{onSelectFile}
									{onSelectDirectory}
									{onToggleDir}
									{onStageFile}
									{onUnstageFile}
									{onStageDir}
									{onUnstageDir}
									{onDiscardFile}
								/>

								{#snippet failed()}
									<div class="flex h-full items-center px-3 text-xs text-status-error-foreground">
										{m.git_diff_document_file_row_failed()}
									</div>
								{/snippet}
							</svelte:boundary>
						</div>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	[data-git-workbench-file-tree]:focus-visible [data-git-tree-row-active] {
		outline: 1px solid var(--color-interactive-accent);
		outline-offset: -1px;
	}
</style>
