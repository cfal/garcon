<script lang="ts">
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import FileIcon from '@lucide/svelte/icons/file';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Plus from '@lucide/svelte/icons/plus';
	import type { GitTreeNode } from '$lib/api/git.js';
	import { FixedVirtualWindow } from '$lib/components/virtual/fixed-virtual-window.svelte';
	import type { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
	import {
		buildCommitTreeRows,
		COMMIT_TREE_ROW_HEIGHT,
		COMMIT_TREE_ROW_OVERSCAN,
		type CommitDirectoryTreeRow,
		type CommitFileTreeRow,
		type CommitTreeRow,
	} from '$lib/git/commit/commit-tree-rows.js';
	import * as m from '$lib/paraglide/messages.js';
	import { nativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';

	interface Props {
		controller: CommitController;
	}

	let { controller }: Props = $props();
	let viewportRef = $state<HTMLElement | null>(null);
	const primaryScrollRegion = nativeWorkspaceScrollRegion('primary');
	const rootFontSize = (() => {
		if (typeof window === 'undefined') return 16;
		const value = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);
		return Number.isFinite(value) && value > 0 ? value : 16;
	})();
	const rowHeight = COMMIT_TREE_ROW_HEIGHT * Math.max(1, rootFontSize / 16);
	let rows = $derived(buildCommitTreeRows(controller.tree, controller.intents));
	const virtualWindow = new FixedVirtualWindow({
		get itemCount() {
			return rows.length;
		},
		get rowHeight() {
			return rowHeight;
		},
		get overscan() {
			return COMMIT_TREE_ROW_OVERSCAN;
		},
		get viewportRef() {
			return viewportRef;
		},
		defaultViewportHeight: 640,
	});
	let visibleRows = $derived.by(() =>
		virtualWindow.visibleIndexes
			.map((index) => ({ index, row: rows[index] }))
			.filter((entry): entry is { index: number; row: CommitTreeRow } => Boolean(entry.row)),
	);

	$effect(() => {
		return virtualWindow.bindViewport();
	});

	$effect(() => {
		return virtualWindow.observeViewport();
	});

	$effect(() => {
		const viewport = viewportRef;
		const maxScrollTop = Math.max(0, virtualWindow.totalHeight - virtualWindow.viewportHeight);
		if (!viewport || virtualWindow.scrollTop <= maxScrollTop) return;
		viewport.scrollTop = maxScrollTop;
		virtualWindow.scrollTop = viewport.scrollTop;
	});

	function fileBadge(node: GitTreeNode): string {
		if (node.staged && node.hasUnstaged) return 'mixed';
		if (node.changeKind === 'untracked') return 'untracked';
		if (node.staged) return 'staged';
		return 'unstaged';
	}

	function indeterminate(
		node: HTMLInputElement,
		value: boolean,
	): { update(nextValue: boolean): void } {
		node.indeterminate = value;
		return {
			update(nextValue: boolean) {
				node.indeterminate = nextValue;
			},
		};
	}
</script>

<div class="relative flex h-full min-w-0 flex-col overflow-hidden">
	<div
		bind:this={viewportRef}
		class="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden py-1 {controller.treeErrorMessage
			? 'pb-12'
			: ''}"
		{@attach primaryScrollRegion}
		data-commit-file-scroll
	>
		{#if controller.isLoadingTree}
			<div class="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground">
				<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
				<span>{m.filetree_loading()}</span>
			</div>
		{:else if rows.length === 0}
			<div class="px-3 py-8 text-center text-xs text-muted-foreground">
				{m.git_quick_commit_no_changed_files()}
			</div>
		{:else}
			<div
				class="relative w-full"
				style={`height:${virtualWindow.totalHeight}px;`}
				data-commit-file-virtual-list
			>
				{#each visibleRows as entry (entry.row.node.path)}
					<div
						class="absolute left-0 right-0 top-0 overflow-hidden"
						style={`height:${rowHeight}px; transform:translateY(${virtualWindow.getOffset(entry.index)}px);`}
						data-commit-tree-row={entry.row.node.path}
						data-commit-tree-index={entry.index}
						data-commit-tree-depth={entry.row.depth}
					>
						<svelte:boundary>
							{#if entry.row.kind === 'directory'}
								{@render directoryRow(entry.row)}
							{:else}
								{@render fileRow(entry.row)}
							{/if}

							{#snippet failed()}
								<div
									class="flex h-full items-center gap-2 px-3 text-xs text-status-error-foreground"
								>
									<AlertTriangle class="h-3.5 w-3.5 shrink-0" />
									<span class="truncate">{m.git_diff_document_file_row_failed()}</span>
								</div>
							{/snippet}
						</svelte:boundary>
					</div>
				{/each}
			</div>
		{/if}
	</div>
	{#if controller.treeErrorMessage}
		<div
			class="absolute inset-x-0 bottom-0 border-t border-status-error-border bg-status-error px-3 py-2 text-xs text-status-error-foreground shadow-sm"
		>
			<div class="flex min-w-0 items-center gap-2">
				<AlertTriangle class="h-3.5 w-3.5 shrink-0" />
				<span class="min-w-0 flex-1 truncate" title={controller.treeErrorMessage}>
					{controller.treeErrorMessage}
				</span>
			</div>
		</div>
	{/if}
</div>

{#snippet directoryRow(row: CommitDirectoryTreeRow)}
	{@const selection = row.selection}
	<div
		class="group flex h-full min-w-0 max-w-full items-center gap-2 overflow-hidden px-2 text-xs text-muted-foreground hover:bg-muted/50"
		style:padding-left={`${row.depth * 14 + 10}px`}
	>
		<input
			type="checkbox"
			checked={selection.checked}
			use:indeterminate={selection.mixed}
			onchange={() =>
				controller.toggleDirectory(row.node.path, selection.mixed ? true : !selection.checked)}
			disabled={selection.fileCount === 0}
			class="size-3.5 shrink-0 accent-current"
			aria-checked={selection.mixed ? 'mixed' : selection.checked}
			aria-label={selection.checked && !selection.mixed
				? m.git_quick_commit_unstage_path({ path: row.node.path })
				: m.git_quick_commit_stage_path({ path: row.node.path })}
		/>
		{#if selection.isRunning}
			<LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
		{:else}
			<FolderIcon class="h-3.5 w-3.5 shrink-0" />
		{/if}
		<span class="min-w-0 flex-1 truncate" title={row.node.path}>{row.node.name}</span>
		{#if row.node.additions || row.node.deletions}
			<span class="flex shrink-0 gap-1 tabular-nums">
				{#if row.node.additions}
					<span class="text-git-added">+{row.node.additions}</span>
				{/if}
				{#if row.node.deletions}
					<span class="text-git-deleted">-{row.node.deletions}</span>
				{/if}
			</span>
		{/if}
	</div>
{/snippet}

{#snippet fileRow(row: CommitFileTreeRow)}
	<div
		class="group flex h-full min-w-0 max-w-full items-center gap-2 overflow-hidden px-2 text-xs hover:bg-muted/50"
		style:padding-left={`${row.depth * 14 + 10}px`}
	>
		<input
			type="checkbox"
			checked={row.intent?.desiredSelected ?? false}
			onchange={(event) => controller.togglePath(row.node.path, event.currentTarget.checked)}
			class="size-3.5 shrink-0 accent-current"
			aria-label={controller.operationLabelForPath(row.node.path)}
		/>
		{#if row.intent?.isRunning}
			<LoaderCircle
				class="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
				aria-label={controller.operationLabelForPath(row.node.path)}
			/>
		{:else}
			<FileIcon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
		{/if}
		<span class="min-w-0 flex-1 truncate text-foreground" title={row.node.path}
			>{row.node.name}</span
		>
		{#if row.stats.additions > 0 || row.stats.deletions > 0}
			<span class="flex shrink-0 gap-1 tabular-nums">
				{#if row.stats.additions > 0}
					<span class="text-git-added">+{row.stats.additions}</span>
				{/if}
				{#if row.stats.deletions > 0}
					<span class="text-git-deleted">-{row.stats.deletions}</span>
				{/if}
			</span>
		{/if}
		<span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
			{fileBadge(row.node)}
		</span>
		{#if row.node.staged && row.node.hasUnstaged}
			<button
				type="button"
				onclick={() => controller.includeUnstaged(row.node.path)}
				class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:hidden"
				title={m.git_quick_commit_include_unstaged()}
				aria-label={m.git_quick_commit_include_unstaged()}
			>
				<Plus class="h-3 w-3" />
			</button>
			<button
				type="button"
				onclick={() => controller.includeUnstaged(row.node.path)}
				class="hidden shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:inline-flex sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
			>
				{m.git_quick_commit_include_unstaged()}
			</button>
		{/if}
	</div>
{/snippet}
