<script lang="ts">
	import type { GitVirtualReviewRow } from '$lib/stores/git-workbench.svelte.js';
	import GitCommitVirtualDiffRow from './GitCommitVirtualDiffRow.svelte';
	import GitCommitVirtualFileHeader from './GitCommitVirtualFileHeader.svelte';
	import GitVirtualDiffViewport from './GitVirtualDiffViewport.svelte';
	import GitVirtualPlaceholderRow from './GitVirtualPlaceholderRow.svelte';

	interface GitCommitVirtualDiffSurfaceProps {
		rows: GitVirtualReviewRow[];
		fileRowIndex: Map<string, number>;
		fontSize: number;
		scrollToRequest: { filePath: string; token: number } | null;
		overscan?: number;
		onVisibleRowsChange: (rows: GitVirtualReviewRow[]) => void;
		onSelectFile: (filePath: string) => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
	}

	let {
		rows,
		fileRowIndex,
		fontSize,
		scrollToRequest,
		overscan = 18,
		onVisibleRowsChange,
		onSelectFile,
		onOpenInEditor,
	}: GitCommitVirtualDiffSurfaceProps = $props();
</script>

{#snippet renderCommitRow(row: GitVirtualReviewRow)}
	{#if row.kind === 'file-header'}
		<GitCommitVirtualFileHeader {row} {onSelectFile} />
	{:else if row.kind === 'file-placeholder' || row.kind === 'file-limit' || row.kind === 'collection-limit'}
		<GitVirtualPlaceholderRow {row} />
	{:else}
		<GitCommitVirtualDiffRow {row} {fontSize} {onOpenInEditor} />
	{/if}
{/snippet}

<GitVirtualDiffViewport
	{rows}
	{fileRowIndex}
	{fontSize}
	{scrollToRequest}
	{overscan}
	emptyMessage="No files match the current filter."
	{onVisibleRowsChange}
	rowSnippet={renderCommitRow}
/>
