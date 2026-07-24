<script lang="ts">
	import { untrack } from 'svelte';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Search from '@lucide/svelte/icons/search';
	import type { GitCommitFileStatus, GitCommitFileSummary } from '$lib/api/git.js';
	import {
		buildGitChangedFileTree,
		flattenGitChangedFileTree,
		type GitChangedFileTreeRow,
	} from '$lib/git/review/git-changed-file-tree.js';
	import * as m from '$lib/paraglide/messages.js';

	interface GitChangedFileTreeProps {
		files: GitCommitFileSummary[];
		fileFilter: string;
		focusedFilePath: string | null;
		onFileFilterChange: (value: string) => void;
		onSelectFile: (filePath: string) => void;
	}

	let {
		files,
		fileFilter,
		focusedFilePath,
		onFileFilterChange,
		onSelectFile,
	}: GitChangedFileTreeProps = $props();

	const treeId = $props.id();
	let listRef = $state<HTMLDivElement | null>(null);
	let collapsedDirectories = $state(new Set<string>());
	let focusedRowKey = $state<string | null>(null);
	let previousNormalizedFilter = $state('');
	const rowHeight = 30;
	let tree = $derived(buildGitChangedFileTree(files));
	let rows = $derived(flattenGitChangedFileTree(tree, collapsedDirectories));
	let activeFocusKey = $derived(
		focusedRowKey && rows.some((row) => row.key === focusedRowKey)
			? focusedRowKey
			: (rows[0]?.key ?? null),
	);
	const virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => listRef,
		estimateSize: () => rowHeight,
		initialRect: { width: 300, height: 720 },
		overscan: 12,
		getItemKey: (index) => rows[index]?.key ?? index,
	});
	let virtualItems = $derived($virtualizer.getVirtualItems());
	let renderedItems = $derived.by(() => {
		if (virtualItems.length > 0 || rows.length === 0) return virtualItems;
		return rows.slice(0, 24).map((row, index) => ({
			index,
			key: row.key,
			start: index * rowHeight,
			size: rowHeight,
			end: (index + 1) * rowHeight,
		}));
	});
	let totalHeight = $derived($virtualizer.getTotalSize());
	let activeRowIndex = $derived(rows.findIndex((row) => row.key === activeFocusKey));
	let activeDescendantId = $derived(
		activeRowIndex >= 0 && renderedItems.some((virtualItem) => virtualItem.index === activeRowIndex)
			? rowElementId(activeRowIndex)
			: undefined,
	);

	$effect(() => {
		const count = rows.length;
		const scrollElement = listRef;
		untrack(() => {
			$virtualizer.setOptions({
				count,
				getScrollElement: () => scrollElement,
				estimateSize: () => rowHeight,
				initialRect: { width: 300, height: 720 },
				overscan: 12,
				getItemKey: (index) => rows[index]?.key ?? index,
			});
		});
	});

	$effect(() => {
		const normalizedFilter = fileFilter.trim();
		if (normalizedFilter === previousNormalizedFilter) return;
		previousNormalizedFilter = normalizedFilter;
		// Expands filtered results so stale disclosure state cannot hide matching files.
		if (normalizedFilter) collapsedDirectories = new Set();
	});

	function rowElementId(index: number): string {
		return `${treeId}-row-${index}`;
	}

	function statusCode(status: GitCommitFileStatus): string {
		switch (status) {
			case 'added':
				return 'A';
			case 'deleted':
				return 'D';
			case 'renamed':
				return 'R';
			case 'copied':
				return 'C';
			case 'type-changed':
				return 'T';
			case 'modified':
				return 'M';
			default:
				return '?';
		}
	}

	function statusDescription(status: GitCommitFileStatus): string {
		switch (status) {
			case 'added':
				return m.git_diff_document_status_added();
			case 'deleted':
				return m.git_diff_document_status_deleted();
			case 'renamed':
				return m.git_diff_document_status_renamed();
			case 'copied':
				return m.git_diff_document_status_copied();
			case 'type-changed':
				return m.git_diff_document_status_type_changed();
			case 'modified':
				return m.git_diff_document_status_modified();
			default:
				return m.git_diff_document_status_unknown();
		}
	}

	function statusColor(status: GitCommitFileStatus): string {
		switch (status) {
			case 'added':
				return 'text-git-added';
			case 'deleted':
				return 'text-git-deleted';
			case 'renamed':
			case 'copied':
				return 'text-git-renamed';
			case 'modified':
				return 'text-git-modified';
			case 'type-changed':
				return 'text-status-warning';
			default:
				return 'text-muted-foreground';
		}
	}

	function toggleDirectory(path: string): void {
		const next = new Set(collapsedDirectories);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		collapsedDirectories = next;
	}

	function focusRowAt(index: number): void {
		const row = rows[index];
		if (!row) return;
		focusedRowKey = row.key;
		listRef?.focus({ preventScroll: true });
		$virtualizer.scrollToIndex(index, { align: 'auto' });
	}

	function focusParent(row: GitChangedFileTreeRow): void {
		if (!row.parentDirectoryPath) return;
		const parentIndex = rows.findIndex(
			(candidate) =>
				candidate.node.kind === 'directory' && candidate.node.path === row.parentDirectoryPath,
		);
		if (parentIndex >= 0) focusRowAt(parentIndex);
	}

	function activateRow(row: GitChangedFileTreeRow): void {
		focusedRowKey = row.key;
		listRef?.focus({ preventScroll: true });
		if (row.node.kind === 'directory') {
			toggleDirectory(row.node.path);
			return;
		}
		onSelectFile(row.node.path);
	}

	function handleTreeKeydown(event: KeyboardEvent): void {
		const index = activeRowIndex;
		const row = rows[index];
		if (!row) return;
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				focusRowAt(Math.min(rows.length - 1, index + 1));
				break;
			case 'ArrowUp':
				event.preventDefault();
				focusRowAt(Math.max(0, index - 1));
				break;
			case 'Home':
				event.preventDefault();
				focusRowAt(0);
				break;
			case 'End':
				event.preventDefault();
				focusRowAt(rows.length - 1);
				break;
			case 'ArrowRight':
				if (row.node.kind !== 'directory') break;
				event.preventDefault();
				if (collapsedDirectories.has(row.node.path)) toggleDirectory(row.node.path);
				else focusRowAt(index + 1);
				break;
			case 'ArrowLeft':
				event.preventDefault();
				if (row.node.kind === 'directory' && !collapsedDirectories.has(row.node.path)) {
					toggleDirectory(row.node.path);
				} else {
					focusParent(row);
				}
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				activateRow(row);
				break;
		}
	}
</script>

<aside class="flex min-h-0 flex-1 flex-col bg-background">
	<div class="border-b border-border p-2">
		<div class="relative">
			<Search
				class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<input
				type="search"
				class="w-full rounded border border-border bg-background py-1.5 pl-7 pr-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent sm:pointer-fine:text-xs"
				placeholder={m.git_history_filter_files()}
				value={fileFilter}
				oninput={(event) => onFileFilterChange(event.currentTarget.value)}
			/>
		</div>
	</div>
	<div
		bind:this={listRef}
		class="min-h-0 flex-1 overflow-y-auto py-1 focus-visible:outline-none"
		role="tree"
		tabindex="0"
		aria-label={m.git_diff_document_files()}
		aria-activedescendant={activeDescendantId}
		data-git-file-list-virtual-root
		data-git-changed-file-tree
		onkeydown={handleTreeKeydown}
	>
		{#if rows.length === 0}
			<div class="px-3 py-5 text-xs text-muted-foreground">
				{fileFilter.trim() ? m.git_history_no_filter_matches() : m.git_changes_no_changes()}
			</div>
		{:else}
			<div class="relative w-full" style:height={`${totalHeight}px`} role="none">
				{#each renderedItems as virtualItem (virtualItem.key)}
					{@const row = rows[virtualItem.index]}
					{#if row}
						<svelte:boundary>
							{#if row.node.kind === 'directory'}
								{@const collapsed = collapsedDirectories.has(row.node.path)}
								<button
									type="button"
									id={rowElementId(virtualItem.index)}
									role="treeitem"
									tabindex="-1"
									aria-level={row.depth + 1}
									aria-expanded={!collapsed}
									aria-selected={false}
									aria-posinset={row.positionInSet}
									aria-setsize={row.setSize}
									class="absolute left-0 top-0 flex w-full min-w-0 items-center overflow-hidden px-2 text-left text-xs text-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent"
									style:height={`${virtualItem.size}px`}
									style:transform={`translateY(${virtualItem.start}px)`}
									style:padding-left={`${row.depth * 14 + 8}px`}
									title={row.node.path}
									data-git-file-list-row
									data-git-file-tree-directory
									data-git-tree-row-key={row.key}
									data-git-tree-row-active={activeFocusKey === row.key ? '' : undefined}
									onclick={() => activateRow(row)}
								>
									{#if row.depth > 0}
										<span class="pointer-events-none absolute inset-y-0 left-0" aria-hidden="true">
											{#each Array(row.depth) as _, depthIndex}
												<span
													class="absolute inset-y-0 w-px bg-border/70"
													style:left={`${depthIndex * 14 + 15}px`}
												></span>
											{/each}
										</span>
									{/if}
									<span
										class="relative z-10 inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground"
										aria-hidden="true"
									>
										{#if collapsed}
											<ChevronRight class="size-3.5" />
										{:else}
											<ChevronDown class="size-3.5" />
										{/if}
									</span>
									{#if collapsed}
										<Folder
											class="ml-1 mr-1.5 size-3.5 shrink-0 text-file-icon-folder"
											aria-hidden="true"
										/>
									{:else}
										<FolderOpen
											class="ml-1 mr-1.5 size-3.5 shrink-0 text-file-icon-folder"
											aria-hidden="true"
										/>
									{/if}
									<span class="min-w-0 truncate">{row.node.name}</span>
								</button>
							{:else}
								<button
									type="button"
									id={rowElementId(virtualItem.index)}
									role="treeitem"
									tabindex="-1"
									aria-level={row.depth + 1}
									aria-selected={focusedFilePath === row.node.path}
									aria-label={m.git_diff_document_file_tree_item({
										status: statusDescription(row.node.file.status),
										name: row.node.name,
									})}
									aria-posinset={row.positionInSet}
									aria-setsize={row.setSize}
									class="absolute left-0 top-0 flex w-full min-w-0 items-center overflow-hidden px-2 text-left text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent {focusedFilePath ===
									row.node.path
										? 'bg-interactive-accent/10 text-interactive-accent'
										: 'text-foreground'}"
									style:height={`${virtualItem.size}px`}
									style:transform={`translateY(${virtualItem.start}px)`}
									style:padding-left={`${row.depth * 14 + 8}px`}
									title={row.node.path}
									data-git-file-list-row
									data-git-file-tree-file
									data-git-tree-row-key={row.key}
									data-git-tree-row-active={activeFocusKey === row.key ? '' : undefined}
									onclick={() => activateRow(row)}
								>
									{#if row.depth > 0}
										<span class="pointer-events-none absolute inset-y-0 left-0" aria-hidden="true">
											{#each Array(row.depth) as _, depthIndex}
												<span
													class="absolute inset-y-0 w-px bg-border/70"
													style:left={`${depthIndex * 14 + 15}px`}
												></span>
											{/each}
										</span>
									{/if}
									<span class="size-4 shrink-0" aria-hidden="true"></span>
									<span
										class="ml-1 mr-1.5 w-3.5 shrink-0 text-center text-[10px] font-bold {statusColor(
											row.node.file.status,
										)}"
										aria-hidden="true"
									>
										{statusCode(row.node.file.status)}
									</span>
									<span class="min-w-0 truncate">{row.node.name}</span>
								</button>
							{/if}

							{#snippet failed()}
								<div
									class="absolute left-0 top-0 flex w-full items-center px-3 text-xs text-status-error-foreground"
									style:height={`${virtualItem.size}px`}
									style:transform={`translateY(${virtualItem.start}px)`}
								>
									{m.git_diff_document_file_row_failed()}
								</div>
							{/snippet}
						</svelte:boundary>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
</aside>

<style>
	[data-git-changed-file-tree]:focus-visible [data-git-tree-row-active] {
		outline: 1px solid var(--color-interactive-accent);
		outline-offset: -1px;
	}
</style>
