<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Copy from '@lucide/svelte/icons/copy';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import GitCompareArrows from '@lucide/svelte/icons/git-compare-arrows';
	import History from '@lucide/svelte/icons/history';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import type { GitHistoryCommitListItem } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';

	interface GitCommitListScreenProps {
		commits: GitHistoryCommitListItem[];
		isLoading: boolean;
		error: string | null;
		nextOffset: number | null;
		isMobile: boolean;
		scrollTop: number;
		onOpenCommit: (hash: string) => void;
		onRevertCommit: (commit: GitHistoryCommitListItem) => void;
		onLoadMore: () => void;
		onScrollSave: (top: number) => void;
		comparisonSelectionActive: boolean;
		comparisonSelectionSlot: 'from' | 'to';
		comparisonFrom: string | null;
		comparisonTo: string | null;
		onBeginComparison: () => void;
		onCancelComparison: () => void;
		onSelectComparisonCommit: (hash: string) => void;
		onSelectComparisonSlot: (slot: 'from' | 'to') => void;
		onOpenComparison: () => void;
		onOpenSelectedComparison: () => void;
	}

	let {
		commits,
		isLoading,
		error,
		nextOffset,
		isMobile,
		scrollTop,
		onOpenCommit,
		onRevertCommit,
		onLoadMore,
		onScrollSave,
		comparisonSelectionActive,
		comparisonSelectionSlot,
		comparisonFrom,
		comparisonTo,
		onBeginComparison,
		onCancelComparison,
		onSelectComparisonCommit,
		onSelectComparisonSlot,
		onOpenComparison,
		onOpenSelectedComparison,
	}: GitCommitListScreenProps = $props();

	let listRef = $state<HTMLDivElement | null>(null);
	let restoredScroll = false;
	let copiedHash = $state<string | null>(null);
	let copyTimeout: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const element = listRef;
		const top = scrollTop;
		if (!element || restoredScroll) return;
		restoredScroll = true;
		requestAnimationFrame(() => {
			element.scrollTop = top;
		});
	});

	function formatDate(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		}).format(date);
	}

	async function copyCommitHash(event: MouseEvent, hash: string): Promise<void> {
		event.stopPropagation();
		await navigator.clipboard?.writeText(hash);
		copiedHash = hash;
		if (copyTimeout) clearTimeout(copyTimeout);
		copyTimeout = setTimeout(() => {
			if (copiedHash === hash) copiedHash = null;
		}, 1200);
	}
</script>

<div
	bind:this={listRef}
	class="flex-1 overflow-y-auto bg-background {isMobile ? 'pb-16' : ''}"
	onscroll={(event) => onScrollSave(event.currentTarget.scrollTop)}
>
	<div class="sticky top-0 z-10 border-b border-border bg-background/95 px-3 py-2 backdrop-blur">
		{#if comparisonSelectionActive}
			<div class="flex flex-wrap items-center gap-2 text-xs">
				<button
					type="button"
					class="rounded border px-2 py-1 font-medium {comparisonSelectionSlot === 'from'
						? 'border-interactive-accent bg-interactive-accent/10 text-interactive-accent'
						: 'border-border text-muted-foreground'}"
					aria-pressed={comparisonSelectionSlot === 'from'}
					onclick={() => onSelectComparisonSlot('from')}
					>{m.git_compare_from()}
					<span class="font-mono"
						>{comparisonFrom?.slice(0, 8) ?? m.git_compare_select_revision()}</span
					></button
				>
				<ArrowRight class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
				<button
					type="button"
					class="rounded border px-2 py-1 font-medium {comparisonSelectionSlot === 'to'
						? 'border-interactive-accent bg-interactive-accent/10 text-interactive-accent'
						: 'border-border text-muted-foreground'}"
					aria-pressed={comparisonSelectionSlot === 'to'}
					onclick={() => onSelectComparisonSlot('to')}
					>{m.git_compare_to()}
					<span class="font-mono"
						>{comparisonTo?.slice(0, 8) ?? m.git_compare_select_revision()}</span
					></button
				>
				<span class="min-w-0 flex-1 text-muted-foreground">{m.git_compare_selection_order()}</span>
				<button
					type="button"
					class="rounded bg-muted px-2.5 py-1 font-medium text-muted-foreground hover:text-foreground"
					onclick={onCancelComparison}>{m.git_confirm_cancel()}</button
				>
				<button
					type="button"
					class="rounded bg-interactive-accent px-2.5 py-1 font-medium text-interactive-accent-foreground disabled:opacity-50"
					disabled={!comparisonFrom || !comparisonTo}
					onclick={onOpenSelectedComparison}>{m.git_compare_action()}</button
				>
			</div>
		{:else}
			<div class="flex flex-wrap items-center gap-2">
				<button
					type="button"
					class="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					onclick={onOpenComparison}
				>
					<GitCompareArrows class="h-3.5 w-3.5" />
					{m.git_compare_title()}
				</button>
				<button
					type="button"
					class="rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					onclick={onBeginComparison}
				>
					{m.git_compare_select_commits()}
				</button>
			</div>
		{/if}
	</div>
	{#if error}
		<div
			class="m-3 rounded border border-status-error-border bg-status-error/10 px-3 py-2 text-sm text-status-error-foreground"
		>
			{error}
		</div>
	{/if}

	{#if isLoading && commits.length === 0}
		<div class="flex h-32 items-center justify-center">
			<RefreshCw class="h-6 w-6 animate-spin text-muted-foreground" />
		</div>
	{:else if commits.length === 0}
		<div class="flex h-32 flex-col items-center justify-center text-muted-foreground">
			<History class="mb-2 h-12 w-12 opacity-50" />
			<p class="text-sm">{m.git_history_no_commits()}</p>
		</div>
	{:else}
		<div class="divide-y divide-border">
			{#each commits as commit (commit.hash)}
				<div
					class="group px-3 py-2 hover:bg-muted/40 {comparisonFrom === commit.hash ||
					comparisonTo === commit.hash
						? 'bg-interactive-accent/10'
						: ''}"
				>
					<div class="flex items-stretch gap-2">
						<button
							type="button"
							class="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
							aria-pressed={comparisonSelectionActive
								? comparisonFrom === commit.hash || comparisonTo === commit.hash
								: undefined}
							aria-label={comparisonSelectionActive
								? m.git_compare_select_commit_for({
										commit: commit.subject || commit.shortHash,
										endpoint:
											comparisonSelectionSlot === 'from'
												? m.git_compare_from()
												: m.git_compare_to(),
									})
								: undefined}
							onclick={() =>
								comparisonSelectionActive
									? onSelectComparisonCommit(commit.hash)
									: onOpenCommit(commit.hash)}
						>
							<div class="flex min-w-0 items-center gap-2">
								<span class="min-w-0 truncate text-sm font-medium text-foreground">
									{commit.subject || commit.shortHash}
								</span>
								{#if commit.parents.length > 1}
									<span class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
										merge
									</span>
								{/if}
							</div>
							<div
								class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
							>
								<span class="truncate">{commit.author}</span>
								<span>{formatDate(commit.authorDate)}</span>
								<span class="font-mono">{commit.shortHash}</span>
								{#if commit.refs.length > 0}
									<span
										class="inline-flex min-w-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5"
									>
										<GitBranch class="h-3 w-3 shrink-0" />
										<span class="truncate">{commit.refs.join(', ')}</span>
									</span>
								{/if}
							</div>
						</button>
						<button
							type="button"
							class="self-center rounded p-1 text-muted-foreground opacity-70 hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
							title={copiedHash === commit.hash ? 'Copied commit hash' : 'Copy commit hash'}
							aria-label={copiedHash === commit.hash ? 'Copied commit hash' : 'Copy commit hash'}
							onclick={(event) => copyCommitHash(event, commit.hash)}
						>
							<Copy class="h-3.5 w-3.5" />
						</button>
						<ChevronRight class="self-center h-4 w-4 shrink-0 text-muted-foreground" />
					</div>
					{#if !comparisonSelectionActive}<div class="mt-2 flex justify-end">
							<button
								type="button"
								class="inline-flex items-center gap-1.5 rounded border border-status-warning-border px-2.5 py-1 text-xs font-medium text-status-warning hover:bg-status-warning/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
								onclick={() => onRevertCommit(commit)}
							>
								<Undo2 class="h-3.5 w-3.5" />
								Revert
							</button>
						</div>{/if}
				</div>
			{/each}
		</div>
		<div class="flex justify-center px-3 py-3">
			{#if nextOffset !== null}
				<button
					type="button"
					class="inline-flex items-center gap-2 rounded border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					disabled={isLoading}
					onclick={onLoadMore}
				>
					{#if isLoading}
						<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
					{/if}
					Load more
				</button>
			{/if}
		</div>
	{/if}
</div>
