<script lang="ts">
	// File tree panel for the git workbench. Renders a collapsible directory
	// hierarchy with change-kind badges and selection highlighting.

	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import FileIcon from '@lucide/svelte/icons/file';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Search from '@lucide/svelte/icons/search';
	import Plus from '@lucide/svelte/icons/plus';
	import Minus from '@lucide/svelte/icons/minus';
	import type { GitTreeNode, GitChangeKind } from '$lib/api/git.js';

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
		/** When true, stage/unstage buttons are always visible (for touch). */
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
		alwaysShowActions = false,
	}: GitFileTreeProps = $props();

	const actionVisibility = $derived(alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100');
	const treeGuideIndentPx = 12;
	const treeGuideStartPx = 8;
	const treeGuideToggleCenterOffsetPx = 10;

	function treeGuideColumnLeft(depthIndex: number): number {
		return treeGuideStartPx + depthIndex * treeGuideIndentPx + treeGuideToggleCenterOffsetPx;
	}

	function changeKindColor(kind?: GitChangeKind): string {
		switch (kind) {
			case 'modified': return 'text-git-modified';
			case 'added': return 'text-git-added';
			case 'deleted': return 'text-git-deleted';
			case 'untracked': return 'text-git-untracked';
			case 'renamed': return 'text-git-renamed';
			default: return 'text-muted-foreground';
		}
	}

	function changeKindBadge(kind?: GitChangeKind): string {
		switch (kind) {
			case 'modified': return 'M';
			case 'added': return 'A';
			case 'deleted': return 'D';
			case 'untracked': return 'U';
			case 'renamed': return 'R';
			default: return '';
		}
	}

	function handleKeyDown(e: KeyboardEvent, path: string, isDir: boolean): void {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			if (isDir) onToggleDir(path);
			else onSelectFile(path);
		}
	}
</script>

<div class="flex flex-col h-full bg-background">
	<!-- Header with count and search -->
	<div class="px-3 py-2 border-b border-border">
		<div class="flex items-center justify-between mb-2">
			<span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
				Files ({totalChangedFiles})
			</span>
		</div>

		<!-- Search -->
		<div class="relative">
			<Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
			<input
				type="text"
				placeholder="Filter files..."
				value={treeSearchQuery}
				oninput={(e) => onSearchChange(e.currentTarget.value)}
				class="w-full pl-7 pr-2 py-1 text-xs bg-muted border border-border rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			/>
		</div>
	</div>

	<!-- Tree content -->
	<div class="flex-1 overflow-y-auto py-1">
		{#if tree.length === 0}
			<div class="px-3 py-4 text-xs text-muted-foreground text-center">
				No changed files
			</div>
		{:else}
			{#each tree as node}
				{@render treeNode(node, 0)}
			{/each}
		{/if}
	</div>
</div>

{#snippet treeNode(node: GitTreeNode, depth: number)}
	{#if node.kind === 'directory'}
		{@const isCollapsed = collapsedDirs.has(node.path)}
		<div
			class="relative flex items-center w-full px-2 py-1 text-xs hover:bg-muted/50 transition-colors group"
			style="padding-left: {depth * 12 + 8}px"
		>
			{#if depth > 0}
				<div class="absolute inset-y-0 left-0 pointer-events-none" aria-hidden="true">
					{#each Array(depth) as _, depthIndex}
						<span
							class="absolute inset-y-0 w-px bg-border/70"
							style="left: {treeGuideColumnLeft(depthIndex)}px"
						></span>
					{/each}
				</div>
			{/if}
			<button
				type="button"
				onclick={() => onToggleDir(node.path)}
				onkeydown={(e) => handleKeyDown(e, node.path, true)}
				class="w-5 h-5 flex items-center justify-center rounded hover:bg-muted shrink-0"
				aria-label={isCollapsed ? 'Expand directory' : 'Collapse directory'}
			>
				{#if isCollapsed}
					<ChevronRight class="w-3.5 h-3.5 text-muted-foreground" />
				{:else}
					<ChevronDown class="w-3.5 h-3.5 text-muted-foreground" />
				{/if}
			</button>
			<button
				type="button"
				onclick={() => onSelectDirectory?.(node.path)}
				class="flex items-center flex-1 min-w-0 ml-0.5"
			>
				<span class="w-4 h-4 flex items-center justify-center mr-1 text-muted-foreground">
					{#if isCollapsed}
						<FolderIcon class="w-3.5 h-3.5" />
					{:else}
						<FolderOpen class="w-3.5 h-3.5" />
					{/if}
				</span>
				<span class="truncate text-foreground">{node.name}</span>
			</button>
			{#if node.staged && onUnstageDir}
				<button
					onclick={(e) => { e.stopPropagation(); onUnstageDir(node.path); }}
					class="ml-1 p-0.5 rounded {actionVisibility} hover:bg-muted transition-opacity shrink-0"
					title="Unstage directory"
				>
					<Minus class="w-3 h-3 text-git-deleted" />
				</button>
			{:else if (node.hasUnstaged || node.changeKind === 'untracked') && onStageDir}
				<button
					onclick={(e) => { e.stopPropagation(); onStageDir(node.path); }}
					class="ml-1 p-0.5 rounded {actionVisibility} hover:bg-muted transition-opacity shrink-0"
					title="Stage directory"
				>
					<Plus class="w-3 h-3 text-git-added" />
				</button>
			{/if}
		</div>

		{#if !isCollapsed && node.children}
			{#each node.children as child}
				{@render treeNode(child, depth + 1)}
			{/each}
		{/if}
	{:else}
		{@const isSelected = selectedFile === node.path}
		<div
			class="relative flex items-center w-full px-2 py-1 text-xs transition-colors group
				{isSelected ? 'bg-interactive-accent/10 text-interactive-accent' : 'hover:bg-muted/50 text-foreground'}"
			style="padding-left: {depth * 12 + 8}px"
		>
			{#if depth > 0}
				<div class="absolute inset-y-0 left-0 pointer-events-none" aria-hidden="true">
					{#each Array(depth) as _, depthIndex}
						<span
							class="absolute inset-y-0 w-px bg-border/70"
							style="left: {treeGuideColumnLeft(depthIndex)}px"
						></span>
					{/each}
				</div>
			{/if}
			<button
				type="button"
				onclick={() => onSelectFile(node.path)}
				onkeydown={(e) => handleKeyDown(e, node.path, false)}
				class="flex items-center flex-1 min-w-0"
			>
				<span class="w-4 h-4 flex items-center justify-center mr-1">
					<!-- Spacer to align with directory chevrons -->
				</span>
				<span class="w-4 h-4 flex items-center justify-center mr-1.5 text-muted-foreground">
					<FileIcon class="w-3.5 h-3.5" />
				</span>
				<span class="truncate flex-1 text-left">{node.name}</span>
			</button>
			{#if node.additions || node.deletions}
				<span class="ml-1 flex gap-1 text-[10px] shrink-0">
					{#if node.additions}
						<span class="text-git-added">+{node.additions}</span>
					{/if}
					{#if node.deletions}
						<span class="text-git-deleted">-{node.deletions}</span>
					{/if}
				</span>
			{/if}
			{#if node.changeKind}
				<span class="ml-1.5 text-[10px] font-bold shrink-0 {changeKindColor(node.changeKind)}">
					{changeKindBadge(node.changeKind)}
				</span>
			{/if}
			{#if node.staged && onUnstageFile}
				<button
					onclick={(e) => { e.stopPropagation(); onUnstageFile(node.path); }}
					class="ml-1 p-0.5 rounded {actionVisibility} hover:bg-muted transition-opacity shrink-0"
					title="Unstage file"
				>
					<Minus class="w-3 h-3 text-git-deleted" />
				</button>
			{:else if !node.staged && node.hasUnstaged && onStageFile}
				<button
					onclick={(e) => { e.stopPropagation(); onStageFile(node.path); }}
					class="ml-1 p-0.5 rounded {actionVisibility} hover:bg-muted transition-opacity shrink-0"
					title="Stage file"
				>
					<Plus class="w-3 h-3 text-git-added" />
				</button>
			{:else if node.changeKind === 'untracked' && onStageFile}
				<button
					onclick={(e) => { e.stopPropagation(); onStageFile(node.path); }}
					class="ml-1 p-0.5 rounded {actionVisibility} hover:bg-muted transition-opacity shrink-0"
					title="Stage file"
				>
					<Plus class="w-3 h-3 text-git-added" />
				</button>
			{/if}
			{#if node.staged}
				<span class="ml-1 w-1.5 h-1.5 rounded-full bg-git-added shrink-0" title="Staged"></span>
			{/if}
		</div>
	{/if}
{/snippet}
