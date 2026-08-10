<script lang="ts">
	import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
	import type { GitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
	import GitVirtualDiffViewport from '../GitVirtualDiffViewport.svelte';

	interface GitVirtualDiffViewportTestHostProps {
		source: GitVirtualReviewRowSource;
		pinFileHeaders: boolean;
		throwFileHeader?: boolean;
	}

	let {
		source,
		pinFileHeaders,
		throwFileHeader = false,
	}: GitVirtualDiffViewportTestHostProps = $props();

	function rowLabel(row: GitVirtualReviewRow): string {
		if (throwFileHeader && row.kind === 'file-header') throw new Error('broken header');
		return `${row.kind}:${row.filePath}`;
	}
</script>

{#snippet renderTestRow(row: GitVirtualReviewRow)}
	<div data-test-row={row.id}>{rowLabel(row)}</div>
{/snippet}

<GitVirtualDiffViewport
	layoutIdentity="test-layout"
	reviewDocumentId="test-document"
	{source}
	{pinFileHeaders}
	fontSize={12}
	scrollToRequest={null}
	onBodyDemand={() => undefined}
	rowSnippet={renderTestRow}
/>
