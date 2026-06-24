<script lang="ts">
	import FileText from '@lucide/svelte/icons/file-text';
	import type { GitVirtualFileHeaderRow } from '$lib/stores/git/git-virtual-review-document.svelte';

	interface GitCommitVirtualFileHeaderProps {
		row: GitVirtualFileHeaderRow;
		onSelectFile: (filePath: string) => void;
	}

	let { row, onSelectFile }: GitCommitVirtualFileHeaderProps = $props();

	let statusLabel = $derived.by(() => {
		const status = row.file.indexStatus.trim() || 'M';
		switch (status) {
			case '?':
				return 'Unknown';
			case 'A':
				return 'Added';
			case 'D':
				return 'Deleted';
			case 'R':
				return 'Renamed';
			case 'C':
				return 'Copied';
			case 'T':
				return 'Type changed';
			default:
				return 'Modified';
		}
	});
</script>

<div
	class="flex min-h-[42px] items-center gap-2 border-b border-border bg-background px-2 py-1.5 {row.isFocused
		? 'border-l-2 border-l-interactive-accent'
		: 'border-l-2 border-l-transparent'}"
	data-git-file-header
	data-file-path={row.file.path}
>
	<FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
	<button
		type="button"
		class="min-w-0 flex-1 truncate text-left font-mono text-xs text-foreground hover:text-interactive-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
		onclick={() => onSelectFile(row.file.path)}
		title={row.file.path}
	>
		{row.file.path}
		{#if row.file.originalPath}
			<span class="ml-1 text-muted-foreground">from {row.file.originalPath}</span>
		{/if}
	</button>
	<span class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
		{statusLabel}
	</span>
	{#if row.file.category !== 'normal'}
		<span class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
			{row.file.category}
		</span>
	{/if}
	<span class="hidden rounded bg-muted px-1.5 py-0.5 text-[10px] text-git-added sm:inline">
		+{row.file.additions}
	</span>
	<span class="hidden rounded bg-muted px-1.5 py-0.5 text-[10px] text-git-deleted sm:inline">
		-{row.file.deletions}
	</span>
</div>
