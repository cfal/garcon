<script lang="ts">
	// Renders the all-files review stack for read-only PR-style browsing.
	// Keeps list rendering concerns separate from the main workbench shell.

	import GitDiffViewer from './GitDiffViewer.svelte';
	import type { GitFileReviewData, GitDiffTab } from '$lib/api/git.js';
	import type { DiffMode } from '$lib/stores/git-workbench.svelte.js';

	interface DiffListItem {
		filePath: string;
		reviewData: GitFileReviewData | null;
	}

	interface GitAllFilesDiffListProps {
		items: DiffListItem[];
		activeTab?: GitDiffTab;
		diffMode: DiffMode;
		selectedLineKeys: Set<string>;
		itemMinHeightClass?: string;
		onToggleLineSelection: (key: string) => void;
		onSelectLineRange: (startKey: string, endKey: string, allKeys: string[]) => void;
		onStageHunk: (hunkIndex: number) => void;
		onUnstageHunk: (hunkIndex: number) => void;
		onStageLine?: (diffLineIndex: number) => void;
		onUnstageLine?: (diffLineIndex: number) => void;
		onAddCommentForFile: (filePath: string, side: 'before' | 'after', line: number) => void;
	}

	let {
		items,
		activeTab = 'unstaged' as GitDiffTab,
		diffMode,
		selectedLineKeys,
		itemMinHeightClass = 'min-h-64',
		onToggleLineSelection,
		onSelectLineRange,
		onStageHunk,
		onUnstageHunk,
		onStageLine,
		onUnstageLine,
		onAddCommentForFile,
	}: GitAllFilesDiffListProps = $props();
</script>

<div class="h-full overflow-auto divide-y divide-border">
	{#if items.length === 0}
		<div class="h-full flex items-center justify-center text-sm text-muted-foreground">
			No changed files match the current filter
		</div>
	{:else}
		{#each items as item (item.filePath)}
			<div class={itemMinHeightClass}>
				<GitDiffViewer
					reviewData={item.reviewData}
					{activeTab}
					diffMode={diffMode}
					selectedLineKeys={selectedLineKeys}
					isLoading={!item.reviewData}
					readOnly
					onToggleLineSelection={onToggleLineSelection}
					onSelectLineRange={onSelectLineRange}
					onStageHunk={onStageHunk}
					onUnstageHunk={onUnstageHunk}
					{onStageLine}
					{onUnstageLine}
					onAddComment={(side, line) => onAddCommentForFile(item.filePath, side, line)}
				/>
			</div>
		{/each}
	{/if}
</div>
