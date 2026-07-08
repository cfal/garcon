<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Check from '@lucide/svelte/icons/check';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import type { GitRenderedDiffRow, GitReviewFileBody, GitReviewFileSummary } from '$lib/api/git.js';
	import type { PullRequestThread as PullRequestThreadData } from '$lib/api/pull-requests';
	import PullRequestThread from './PullRequestThread.svelte';
	import { fileStatusClass, fileStatusLabel } from './pr-display';
	import { cn } from '$lib/utils/cn';

	interface PullRequestFileDiffProps {
		file: GitReviewFileSummary;
		body: GitReviewFileBody | undefined;
		threads: PullRequestThreadData[];
		viewed: boolean;
		collapsed: boolean;
		onToggleViewed: () => void;
		onToggleCollapsed: () => void;
		onAddressThread: (thread: PullRequestThreadData) => void;
	}

	let {
		file,
		body,
		threads,
		viewed,
		collapsed,
		onToggleViewed,
		onToggleCollapsed,
		onAddressThread,
	}: PullRequestFileDiffProps = $props();

	const lastSlash = $derived(file.path.lastIndexOf('/'));
	const dirName = $derived(lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : '');
	const baseName = $derived(lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path);

	// A GitHub-style 5-segment add/delete proportion bar.
	const statBlocks = $derived.by(() => {
		const total = file.additions + file.deletions;
		if (total === 0) return [];
		let green = Math.round((file.additions / total) * 5);
		if (file.additions > 0 && green === 0) green = 1;
		if (file.deletions > 0 && green === 5) green = 4;
		return Array.from({ length: 5 }, (_, i) => (i < green ? 'add' : 'del'));
	});

	// Anchors each review thread to the diff row matching its line, collecting
	// threads with no matching row (typically outdated) to render at the end.
	const anchored = $derived.by(() => {
		const byRow = new Map<number, PullRequestThreadData[]>();
		const orphans: PullRequestThreadData[] = [];
		const rows = body?.rows ?? [];
		for (const thread of threads) {
			let matchIndex = -1;
			for (let i = 0; i < rows.length; i += 1) {
				const row = rows[i];
				const line = thread.side === 'before' ? row.beforeLine : row.afterLine;
				if (line === thread.line && thread.line > 0) {
					matchIndex = i;
					break;
				}
			}
			if (matchIndex >= 0) {
				const list = byRow.get(matchIndex) ?? [];
				list.push(thread);
				byRow.set(matchIndex, list);
			} else {
				orphans.push(thread);
			}
		}
		return { byRow, orphans };
	});

	function codeCellClass(kind: GitRenderedDiffRow['kind']): string {
		if (kind === 'add') return 'bg-diff-add text-diff-add-fg';
		if (kind === 'del') return 'bg-diff-del text-diff-del-fg';
		return 'text-foreground';
	}

	function rowSign(kind: GitRenderedDiffRow['kind']): string {
		if (kind === 'add') return '+';
		if (kind === 'del') return '-';
		return '';
	}

	const gutterClass = 'w-10 flex-shrink-0 select-none bg-muted/40 px-1 text-right text-[10px] text-muted-foreground tabular-nums';
</script>

<div class="rounded-md border border-border">
	<div
		class="sticky top-0 z-10 flex items-center gap-2 rounded-t-md border-b border-border bg-muted/70 px-2 py-1.5 backdrop-blur"
	>
		<button
			type="button"
			class="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none"
			onclick={onToggleCollapsed}
			aria-expanded={!collapsed}
		>
			{#if collapsed}
				<ChevronRight class="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
			{:else}
				<ChevronDown class="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
			{/if}
			<span
				class={cn('flex-shrink-0 text-[10px] font-semibold uppercase', fileStatusClass(file.workTreeStatus))}
				title={fileStatusLabel(file.workTreeStatus)}
			>
				{file.workTreeStatus}
			</span>
			<span class="truncate font-mono text-xs" title={file.path}>
				<span class="text-muted-foreground">{dirName}</span><span class="font-medium text-foreground">{baseName}</span>
			</span>
			{#if threads.length > 0}
				<span
					class="flex flex-shrink-0 items-center gap-0.5 rounded-full bg-accent px-1.5 text-[10px] font-medium text-accent-foreground"
				>
					<MessageSquare class="h-2.5 w-2.5" />
					{threads.length}
				</span>
			{/if}
		</button>
		<span class="flex flex-shrink-0 items-center gap-2">
			<span class="text-[11px] font-medium tabular-nums">
				<span class="text-git-added">+{file.additions}</span>
				<span class="text-git-deleted">−{file.deletions}</span>
			</span>
			{#if statBlocks.length > 0}
				<span class="hidden items-center gap-px sm:flex" aria-hidden="true">
					{#each statBlocks as block, i (i)}
						<span
							class={cn('h-2 w-2 rounded-[1px]', block === 'add' ? 'bg-git-added' : 'bg-git-deleted')}
						></span>
					{/each}
				</span>
			{/if}
		</span>
		<button
			type="button"
			class={cn(
				'flex flex-shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
				viewed
					? 'border-git-added/40 bg-git-added/10 text-git-added'
					: 'border-border text-muted-foreground hover:bg-accent',
			)}
			onclick={onToggleViewed}
			aria-pressed={viewed}
			title={viewed ? 'Mark as not viewed' : 'Mark as viewed'}
		>
			<Check class="h-3 w-3" />
			Viewed
		</button>
	</div>

	{#if !collapsed}
		{#if body?.bodyState === 'loaded' && body.rows.length > 0}
			<div class="overflow-x-auto font-mono text-xs leading-5">
				{#each body.rows as row, i (row.key)}
					{#if row.kind === 'hunk'}
						<div class="bg-diff-hunk-header px-2 py-0.5 text-diff-hunk opacity-90">{row.text}</div>
					{:else}
						<div class="flex">
							<span class={gutterClass}>{row.beforeLine ?? ''}</span>
							<span class={gutterClass}>{row.afterLine ?? ''}</span>
							<span class={cn('flex flex-1', codeCellClass(row.kind))}>
								<span class="w-4 flex-shrink-0 select-none text-center">{rowSign(row.kind)}</span>
								<span class="flex-1 whitespace-pre-wrap break-all pr-2">{row.text || ' '}</span>
							</span>
						</div>
					{/if}
					{#each anchored.byRow.get(i) ?? [] as thread (thread.id)}
						<div class="border-y border-border bg-background px-2">
							<PullRequestThread {thread} onAddress={() => onAddressThread(thread)} />
						</div>
					{/each}
				{/each}
			</div>
		{:else if body && (body.isBinary || body.isTooLarge)}
			<div class="px-3 py-2 text-xs text-muted-foreground">
				{body.limitMessage ?? 'Diff is not shown for this file.'}
			</div>
		{:else}
			<div class="px-3 py-2 text-xs text-muted-foreground">No diff available for this file.</div>
		{/if}

		{#if anchored.orphans.length > 0}
			<div class="border-t border-border bg-background px-2 py-1">
				<div class="px-1 py-1 text-[10px] font-medium uppercase text-muted-foreground">
					Comments not on the current diff
				</div>
				{#each anchored.orphans as thread (thread.id)}
					<PullRequestThread {thread} onAddress={() => onAddressThread(thread)} />
				{/each}
			</div>
		{/if}
	{/if}
</div>
