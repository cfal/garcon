<script lang="ts">
	// Renders the all-files review stack for read-only PR-style browsing.
	// Keeps list rendering concerns separate from the main workbench shell.

	import GitDiffViewer from './GitDiffViewer.svelte';
	import type { GitFileReviewData, GitDiffTab } from '$lib/api/git.js';
	import type { DiffMode, GitDiffActionTarget } from '$lib/stores/git-workbench.svelte.js';

	interface DiffListItem {
		filePath: string;
		reviewData: GitFileReviewData | null;
	}

	interface GitAllFilesDiffListProps {
		items: DiffListItem[];
		activeTab?: GitDiffTab;
		diffMode: DiffMode;
		selectedLineKeys: Set<string>;
		operationPending?: boolean;
		itemMinHeightClass?: string;
		onToggleLineSelection: (key: string) => void;
		onSelectLineRange: (startKey: string, endKey: string, allKeys: string[]) => void;
		onStageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onUnstageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onStageLine?: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onUnstageLine?: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onAddCommentForFile: (filePath: string, side: 'before' | 'after', line: number) => void;
	}

	let {
		items,
		activeTab = 'unstaged' as GitDiffTab,
		diffMode,
		selectedLineKeys,
		operationPending = false,
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
					filePath={item.filePath}
					reviewData={item.reviewData}
					{activeTab}
					{diffMode}
					{selectedLineKeys}
					{operationPending}
					isLoading={!item.reviewData}
					readOnly
					{onToggleLineSelection}
					{onSelectLineRange}
					{onStageHunk}
					{onUnstageHunk}
					{onStageLine}
					{onUnstageLine}
					onAddComment={(side: 'before' | 'after', line: number) =>
						onAddCommentForFile(item.filePath, side, line)}
				/>
			</div>
		{/each}
	{/if}
</div>
