<script lang="ts">
	import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
	import type { GitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
	import type { PullRequestThread as PullRequestThreadData } from '$lib/api/pull-requests.js';
	import GitVirtualDiffRow from '$lib/components/git/GitVirtualDiffRow.svelte';
	import GitVirtualDiffViewport from '$lib/components/git/GitVirtualDiffViewport.svelte';
	import GitVirtualPlaceholderRow from '$lib/components/git/GitVirtualPlaceholderRow.svelte';
	import PullRequestThread from './PullRequestThread.svelte';
	import PullRequestVirtualFileHeader from './PullRequestVirtualFileHeader.svelte';

	interface PullRequestVirtualDiffSurfaceProps {
		documentId: string;
		source: GitVirtualReviewRowSource;
		viewedFiles: ReadonlySet<string>;
		collapsedFiles: ReadonlySet<string>;
		threadsById: ReadonlyMap<string, PullRequestThreadData>;
		threadCountByFile: ReadonlyMap<string, number>;
		onToggleViewed: (filePath: string) => void;
		onToggleCollapsed: (filePath: string) => void;
		onAddressThread: (thread: PullRequestThreadData) => void;
	}

	let {
		documentId,
		source,
		viewedFiles,
		collapsedFiles,
		threadsById,
		threadCountByFile,
		onToggleViewed,
		onToggleCollapsed,
		onAddressThread,
	}: PullRequestVirtualDiffSurfaceProps = $props();

	const readOnlyInteraction = { kind: 'read-only' as const };
</script>

{#snippet renderRow(row: GitVirtualReviewRow)}
	{#if row.kind === 'file-header'}
		<PullRequestVirtualFileHeader
			{row}
			viewed={viewedFiles.has(row.filePath)}
			collapsed={collapsedFiles.has(row.filePath)}
			threadCount={threadCountByFile.get(row.filePath) ?? 0}
			{onToggleViewed}
			{onToggleCollapsed}
		/>
	{:else if row.kind === 'file-placeholder' || row.kind === 'file-limit' || row.kind === 'collection-limit'}
		<GitVirtualPlaceholderRow {row} />
	{:else if row.kind === 'review-thread'}
		{@const thread = threadsById.get(row.threadId)}
		{#if thread}
			<div class="border-y border-border bg-background px-2 py-1">
				{#if row.showUnanchoredLabel}
					<div class="px-1 py-1 text-[10px] font-medium uppercase text-muted-foreground">
						Comments not on the current diff
					</div>
				{/if}
				<PullRequestThread {thread} onAddress={() => onAddressThread(thread)} />
			</div>
		{/if}
	{:else if row.kind === 'unified-row' || row.kind === 'split-row'}
		<GitVirtualDiffRow {row} fontSize={12} interaction={readOnlyInteraction} />
	{/if}
{/snippet}

<GitVirtualDiffViewport
	{documentId}
	{source}
	fontSize={12}
	scrollToRequest={null}
	onVisibleRowsChange={() => undefined}
	rowSnippet={renderRow}
/>
