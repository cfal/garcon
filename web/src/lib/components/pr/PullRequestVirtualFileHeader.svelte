<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import type { GitVirtualFileHeaderRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
	import { cn } from '$lib/utils/cn.js';
	import { fileStatusClass, fileStatusLabel } from './pr-display.js';

	interface PullRequestVirtualFileHeaderProps {
		row: GitVirtualFileHeaderRow;
		viewed: boolean;
		collapsed: boolean;
		threadCount: number;
		onToggleViewed: (filePath: string) => void;
		onToggleCollapsed: (filePath: string) => void;
	}

	let {
		row,
		viewed,
		collapsed,
		threadCount,
		onToggleViewed,
		onToggleCollapsed,
	}: PullRequestVirtualFileHeaderProps = $props();

	const lastSlash = $derived(row.file.path.lastIndexOf('/'));
	const dirName = $derived(lastSlash >= 0 ? row.file.path.slice(0, lastSlash + 1) : '');
	const baseName = $derived(
		lastSlash >= 0 ? row.file.path.slice(lastSlash + 1) : row.file.path,
	);
</script>

<div class="flex h-[42px] items-center gap-2 border-y border-border bg-muted/70 px-2">
	<button
		type="button"
		class="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
		onclick={() => onToggleCollapsed(row.filePath)}
		aria-expanded={!collapsed}
	>
		{#if collapsed}
			<ChevronRight class="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
		{:else}
			<ChevronDown class="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
		{/if}
		<span
			class={cn(
				'flex-shrink-0 text-[10px] font-semibold uppercase',
				fileStatusClass(row.file.workTreeStatus),
			)}
			title={fileStatusLabel(row.file.workTreeStatus)}
		>
			{row.file.workTreeStatus}
		</span>
		<span class="truncate font-mono text-xs" title={row.file.path}>
			<span class="text-muted-foreground">{dirName}</span><span class="font-medium text-foreground"
				>{baseName}</span
			>
		</span>
		{#if threadCount > 0}
			<span
				class="flex flex-shrink-0 items-center gap-0.5 rounded-full bg-accent px-1.5 text-[10px] font-medium text-accent-foreground"
				title={`${threadCount} review ${threadCount === 1 ? 'thread' : 'threads'}`}
			>
				<MessageSquare class="h-2.5 w-2.5" />
				{threadCount}
			</span>
		{/if}
	</button>
	<span class="flex-shrink-0 text-[11px] font-medium tabular-nums">
		<span class="text-git-added">+{row.file.additions}</span>
		<span class="ml-1 text-git-deleted">-{row.file.deletions}</span>
	</span>
	<button
		type="button"
		class={cn(
			'inline-flex flex-shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent',
			viewed
				? 'border-git-added/40 bg-git-added/10 text-git-added'
				: 'border-border text-muted-foreground hover:bg-accent',
		)}
		onclick={() => onToggleViewed(row.filePath)}
		aria-pressed={viewed}
		title={viewed ? 'Mark as not viewed' : 'Mark as viewed'}
	>
		<Check class="h-3 w-3" />
		Viewed
	</button>
</div>
