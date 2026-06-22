<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import FileText from '@lucide/svelte/icons/file-text';
	import type { GitVirtualFileHeaderRow } from '$lib/stores/git/git-virtual-review-document.svelte';

	interface GitVirtualFileHeaderProps {
		row: GitVirtualFileHeaderRow;
		onSelectFile: (filePath: string) => void;
		onToggleViewed: (filePath: string) => void;
	}

	let { row, onSelectFile, onToggleViewed }: GitVirtualFileHeaderProps = $props();

	let statusLabel = $derived.by(() => {
		const status = row.file.workTreeStatus.trim() || row.file.indexStatus.trim() || 'M';
		switch (status) {
			case '?':
				return 'Untracked';
			case 'A':
				return 'Added';
			case 'D':
				return 'Deleted';
			case 'R':
				return 'Renamed';
			case 'C':
				return 'Copied';
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
	<button
		type="button"
		class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
		onclick={() => onToggleViewed(row.file.path)}
		title={row.isViewed ? 'Viewed' : 'Mark viewed'}
	>
		{#if row.isViewed}
			<Check class="h-3 w-3" />
		{/if}
		{row.isViewed ? 'Viewed' : 'Mark viewed'}
	</button>
</div>
