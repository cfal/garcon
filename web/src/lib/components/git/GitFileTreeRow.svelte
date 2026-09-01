<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FileIcon from '@lucide/svelte/icons/file';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import type { GitChangeKind, GitFileReviewCategory } from '$lib/api/git.js';
	import type { GitWorkbenchTreeRow } from '$lib/git/workbench/git-workbench-tree-rows.js';
	import * as m from '$lib/paraglide/messages.js';

	interface GitFileTreeRowProps {
		row: GitWorkbenchTreeRow;
		selected: boolean;
		collapsed: boolean;
		actionVisibility: string;
		stagePending: boolean;
		unstagePending: boolean;
		onFocusRow: () => void;
		onSelectFile: (path: string) => void;
		onSelectDirectory?: (path: string) => void;
		onToggleDir: (path: string) => void;
		onStageFile?: (path: string) => void;
		onUnstageFile?: (path: string) => void;
		onStageDir?: (path: string) => void;
		onUnstageDir?: (path: string) => void;
		onDiscardFile?: (path: string) => void;
	}

	let {
		row,
		selected,
		collapsed,
		actionVisibility,
		stagePending,
		unstagePending,
		onFocusRow,
		onSelectFile,
		onSelectDirectory,
		onToggleDir,
		onStageFile,
		onUnstageFile,
		onStageDir,
		onUnstageDir,
		onDiscardFile,
	}: GitFileTreeRowProps = $props();
	let node = $derived(row.node);

	const treeGuideIndentPx = 12;
	const treeGuideStartPx = 8;
	const treeGuideToggleCenterOffsetPx = 10;

	function treeGuideColumnLeft(depthIndex: number): number {
		return treeGuideStartPx + depthIndex * treeGuideIndentPx + treeGuideToggleCenterOffsetPx;
	}

	function changeKindColor(kind?: GitChangeKind): string {
		switch (kind) {
			case 'modified':
				return 'text-git-modified';
			case 'added':
				return 'text-git-added';
			case 'deleted':
				return 'text-git-deleted';
			case 'untracked':
				return 'text-git-untracked';
			case 'renamed':
				return 'text-git-renamed';
			default:
				return 'text-muted-foreground';
		}
	}

	function changeKindBadge(kind?: GitChangeKind): string {
		switch (kind) {
			case 'modified':
				return 'M';
			case 'added':
				return 'A';
			case 'deleted':
				return 'D';
			case 'untracked':
				return 'U';
			case 'renamed':
				return 'R';
			default:
				return '';
		}
	}

	function categoryBadge(category?: GitFileReviewCategory): string {
		if (category === 'generated') return 'GEN';
		if (category === 'lockfile') return 'LOCK';
		if (category === 'binary') return 'BIN';
		if (category === 'large') return 'LARGE';
		return '';
	}
</script>

<div
	class="relative flex h-full min-w-0 items-center overflow-hidden px-2 text-xs transition-colors
		{selected ? 'bg-interactive-accent/10 text-interactive-accent' : 'hover:bg-muted/50'}"
	style:padding-left={`${row.depth * treeGuideIndentPx + 8}px`}
>
	{#if row.depth > 0}
		<span class="pointer-events-none absolute inset-y-0 left-0" aria-hidden="true">
			{#each Array(row.depth) as _, depthIndex (depthIndex)}
				<span
					class="absolute inset-y-0 w-px bg-border/70"
					style:left={`${treeGuideColumnLeft(depthIndex)}px`}
				></span>
			{/each}
		</span>
	{/if}

	{#if node.kind === 'directory'}
		<button
			type="button"
			onfocus={onFocusRow}
			onclick={() => {
				onFocusRow();
				onToggleDir(node.path);
			}}
			class="relative z-10 flex size-5 shrink-0 items-center justify-center rounded hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			aria-label={collapsed ? m.editor_actions_expand() : m.editor_actions_collapse()}
		>
			{#if collapsed}
				<ChevronRight class="size-3.5 text-muted-foreground" />
			{:else}
				<ChevronDown class="size-3.5 text-muted-foreground" />
			{/if}
		</button>
		<button
			type="button"
			onfocus={onFocusRow}
			onclick={() => {
				onFocusRow();
				onSelectDirectory?.(node.path);
			}}
			class="relative z-10 ml-0.5 flex min-w-0 flex-1 items-center rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
		>
			<span class="mr-1 flex size-4 shrink-0 items-center justify-center text-muted-foreground">
				{#if collapsed}
					<FolderIcon class="size-3.5" />
				{:else}
					<FolderOpen class="size-3.5" />
				{/if}
			</span>
			<span class="truncate text-foreground">{node.name}</span>
		</button>
		{#if (node.hasUnstaged || node.changeKind === 'untracked') && onStageDir}
			<button
				type="button"
				disabled={stagePending}
				onfocus={onFocusRow}
				onclick={() => onStageDir?.(node.path)}
				class="relative z-10 ml-1 shrink-0 rounded p-0.5 {actionVisibility} transition-opacity hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent disabled:opacity-50"
				title={m.git_action_stage_directory()}
			>
				{#if stagePending}
					<LoaderCircle class="size-3 animate-spin text-git-added" />
				{:else}
					<Plus class="size-3 text-git-added" />
				{/if}
			</button>
		{/if}
		{#if node.staged && onUnstageDir}
			<button
				type="button"
				disabled={unstagePending}
				onfocus={onFocusRow}
				onclick={() => onUnstageDir?.(node.path)}
				class="relative z-10 ml-1 shrink-0 rounded p-0.5 {actionVisibility} transition-opacity hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent disabled:opacity-50"
				title={m.git_action_unstage_directory()}
			>
				{#if unstagePending}
					<LoaderCircle class="size-3 animate-spin text-git-deleted" />
				{:else}
					<Minus class="size-3 text-git-deleted" />
				{/if}
			</button>
		{/if}
	{:else}
		{@const badge = categoryBadge(node.category)}
		<button
			type="button"
			onfocus={onFocusRow}
			onclick={() => {
				onFocusRow();
				onSelectFile(node.path);
			}}
			class="relative z-10 flex min-w-0 flex-1 items-center rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
		>
			<span class="mr-1 size-4 shrink-0"></span>
			<span class="mr-1.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground">
				<FileIcon class="size-3.5" />
			</span>
			<span class="min-w-0 flex-1 truncate">{node.name}</span>
		</button>
		{#if node.additions || node.deletions}
			<span class="relative z-10 ml-1 flex shrink-0 gap-1 text-[10px]">
				{#if node.additions}<span class="text-git-added">+{node.additions}</span>{/if}
				{#if node.deletions}<span class="text-git-deleted">-{node.deletions}</span>{/if}
			</span>
		{/if}
		{#if node.changeKind}
			<span
				class="relative z-10 ml-1.5 shrink-0 text-[10px] font-bold {changeKindColor(
					node.changeKind,
				)}"
			>
				{changeKindBadge(node.changeKind)}
			</span>
		{/if}
		{#if badge}
			<span
				class="relative z-10 ml-1 shrink-0 rounded bg-muted px-1 text-[9px] font-medium text-muted-foreground"
			>
				{badge}
			</span>
		{/if}
		{#if (node.hasUnstaged || node.changeKind === 'untracked') && onStageFile}
			{#if onDiscardFile}
				<button
					type="button"
					onfocus={onFocusRow}
					onclick={() => onDiscardFile?.(node.path)}
					class="relative z-10 ml-1 shrink-0 rounded p-0.5 {actionVisibility} transition-opacity hover:bg-status-error/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					title={node.changeKind === 'untracked'
						? m.git_file_item_delete_untracked()
						: m.git_file_item_discard_changes()}
				>
					<Undo2 class="size-3 text-muted-foreground hover:text-status-error-foreground" />
				</button>
			{/if}
			<button
				type="button"
				disabled={stagePending}
				onfocus={onFocusRow}
				onclick={() => onStageFile?.(node.path)}
				class="relative z-10 ml-1 shrink-0 rounded p-0.5 {actionVisibility} transition-opacity hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent disabled:opacity-50"
				title={m.git_action_stage_file()}
			>
				{#if stagePending}
					<LoaderCircle class="size-3 animate-spin text-git-added" />
				{:else}
					<Plus class="size-3 text-git-added" />
				{/if}
			</button>
		{/if}
		{#if node.staged && onUnstageFile}
			<button
				type="button"
				disabled={unstagePending}
				onfocus={onFocusRow}
				onclick={() => onUnstageFile?.(node.path)}
				class="relative z-10 ml-1 shrink-0 rounded p-0.5 {actionVisibility} transition-opacity hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent disabled:opacity-50"
				title={m.git_action_unstage_file()}
			>
				{#if unstagePending}
					<LoaderCircle class="size-3 animate-spin text-git-deleted" />
				{:else}
					<Minus class="size-3 text-git-deleted" />
				{/if}
			</button>
		{/if}
		{#if node.staged}
			<span
				class="relative z-10 ml-1 size-1.5 shrink-0 rounded-full bg-git-added"
				title={m.git_action_staged()}
			></span>
		{/if}
	{/if}
</div>
