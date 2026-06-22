<script lang="ts">
	import FileText from '@lucide/svelte/icons/file-text';
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import type { GitDiffTab, GitStatusCode } from '$lib/api/git.js';
	import type { GitVirtualFileHeaderRow } from '$lib/stores/git/git-virtual-review-document.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface GitVirtualFileHeaderProps {
		row: GitVirtualFileHeaderRow;
		activeTab: GitDiffTab;
		operationPending: boolean;
		onSelectFile: (filePath: string) => void;
		onStageFile: (filePath: string) => void;
		onUnstageFile: (filePath: string) => void;
	}

	let {
		row,
		activeTab,
		operationPending,
		onSelectFile,
		onStageFile,
		onUnstageFile,
	}: GitVirtualFileHeaderProps = $props();

	function hasIndexChange(status: GitStatusCode): boolean {
		return status !== ' ' && status !== '?' && status !== '!' && Boolean(status);
	}

	function hasWorkTreeChange(status: GitStatusCode): boolean {
		return status !== ' ' && status !== '!' && Boolean(status);
	}

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
	let unstagedStatus = $derived(
		row.file.indexStatus === '?' ? row.file.indexStatus : row.file.workTreeStatus,
	);
	let canStageFile = $derived(activeTab === 'unstaged' && hasWorkTreeChange(unstagedStatus));
	let canUnstageFile = $derived(activeTab === 'staged' && hasIndexChange(row.file.indexStatus));
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
	{#if canStageFile}
		<button
			type="button"
			disabled={operationPending}
			class="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-git-added hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			onclick={() => onStageFile(row.file.path)}
			title={m.git_action_stage_file()}
		>
			<Plus class="h-3 w-3" />
			{m.git_action_stage_file()}
		</button>
	{:else if canUnstageFile}
		<button
			type="button"
			disabled={operationPending}
			class="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-git-deleted hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			onclick={() => onUnstageFile(row.file.path)}
			title={m.git_action_unstage_file()}
		>
			<Minus class="h-3 w-3" />
			{m.git_action_unstage_file()}
		</button>
	{/if}
</div>
