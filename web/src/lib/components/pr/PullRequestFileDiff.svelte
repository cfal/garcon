<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import type { GitRenderedDiffRow, GitReviewFileBody, GitReviewFileSummary } from '$lib/api/git.js';
	import type { PullRequestThread as PullRequestThreadData } from '$lib/api/pull-requests';
	import PullRequestThread from './PullRequestThread.svelte';
	import { fileStatusClass, fileStatusLabel } from './pr-display';

	interface PullRequestFileDiffProps {
		file: GitReviewFileSummary;
		body: GitReviewFileBody | undefined;
		threads: PullRequestThreadData[];
		viewed: boolean;
		onToggleViewed: () => void;
		onAddressThread: (thread: PullRequestThreadData) => void;
	}

	let { file, body, threads, viewed, onToggleViewed, onAddressThread }: PullRequestFileDiffProps =
		$props();

	let collapsed = $state(false);

	function toggleViewed(): void {
		const nextViewed = !viewed;
		onToggleViewed();
		collapsed = nextViewed;
	}

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

	function rowBackground(kind: GitRenderedDiffRow['kind']): string {
		if (kind === 'add') return 'bg-diff-add text-diff-add-fg';
		if (kind === 'del') return 'bg-diff-del text-diff-del-fg';
		if (kind === 'hunk') return 'bg-diff-hunk-header text-diff-hunk';
		return 'text-foreground';
	}

	function rowSign(kind: GitRenderedDiffRow['kind']): string {
		if (kind === 'add') return '+';
		if (kind === 'del') return '-';
		return '';
	}
</script>

<div class="overflow-hidden rounded-md border border-border">
	<div class="flex items-center gap-2 bg-muted/40 px-2 py-1.5">
		<button
			type="button"
			class="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none"
			onclick={() => (collapsed = !collapsed)}
			aria-expanded={!collapsed}
		>
			{#if collapsed}
				<ChevronRight class="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
			{:else}
				<ChevronDown class="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
			{/if}
			<span
				class="flex-shrink-0 text-[10px] font-semibold uppercase {fileStatusClass(
					file.workTreeStatus,
				)}"
				title={fileStatusLabel(file.workTreeStatus)}
			>
				{file.workTreeStatus}
			</span>
			<span class="truncate font-mono text-xs text-foreground" title={file.path}>{file.path}</span>
			{#if threads.length > 0}
				<span
					class="flex-shrink-0 rounded-full bg-accent px-1.5 text-[10px] font-medium text-accent-foreground"
				>
					{threads.length}
				</span>
			{/if}
		</button>
		<span class="flex-shrink-0 text-[11px] font-medium text-git-added">+{file.additions}</span>
		<span class="flex-shrink-0 text-[11px] font-medium text-git-deleted">−{file.deletions}</span>
		<label
			class="flex flex-shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground"
		>
			<input
				type="checkbox"
				class="h-3 w-3 accent-primary"
				checked={viewed}
				onchange={toggleViewed}
			/>
			Viewed
		</label>
	</div>

	{#if !collapsed}
		{#if body?.bodyState === 'loaded' && body.rows.length > 0}
			<div class="overflow-x-auto font-mono text-xs leading-5">
				{#each body.rows as row, i (row.key)}
					<div class="flex {rowBackground(row.kind)}">
						{#if row.kind === 'hunk'}
							<span class="w-full select-none px-2 py-0.5 opacity-80">{row.text}</span>
						{:else}
							<span
								class="w-10 flex-shrink-0 select-none px-1 text-right text-[10px] text-muted-foreground tabular-nums"
								>{row.beforeLine ?? ''}</span
							>
							<span
								class="w-10 flex-shrink-0 select-none px-1 text-right text-[10px] text-muted-foreground tabular-nums"
								>{row.afterLine ?? ''}</span
							>
							<span class="w-4 flex-shrink-0 select-none text-center">{rowSign(row.kind)}</span>
							<span class="flex-1 whitespace-pre-wrap break-all px-1">{row.text || ' '}</span>
						{/if}
					</div>
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
