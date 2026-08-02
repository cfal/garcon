<script lang="ts">
	import { tick } from 'svelte';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Copy from '@lucide/svelte/icons/copy';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import History from '@lucide/svelte/icons/history';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import type { GitHistoryCommitListItem } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';

	const LOAD_THRESHOLD_PX = 96;

	interface GitCommitListScreenProps {
		commits: GitHistoryCommitListItem[];
		isLoading: boolean;
		error: string | null;
		nextOffset: number | null;
		isMobile: boolean;
		scrollTop: number;
		onOpenCommit: (hash: string) => void;
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

	$effect(() => {
		const element = listRef;
		const commitCount = commits.length;
		if (!element || commitCount === 0 || isLoading || error || nextOffset === null) return;
		let cancelled = false;

		void tick().then(() => {
			if (cancelled || listRef !== element || commits.length < commitCount) return;
			maybeLoadMore();
		});

		return () => {
			cancelled = true;
		};
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

	function isNearListBottom(): boolean {
		if (!listRef || listRef.clientHeight <= 0) return false;
		return listRef.scrollHeight - listRef.scrollTop - listRef.clientHeight < LOAD_THRESHOLD_PX;
	}

	function maybeLoadMore(): void {
		if (isLoading || error || nextOffset === null || !isNearListBottom()) return;
		onLoadMore();
	}

	function handleScroll(event: Event & { currentTarget: HTMLDivElement }): void {
		onScrollSave(event.currentTarget.scrollTop);
		maybeLoadMore();
	}
</script>

<div
	bind:this={listRef}
	class="flex-1 overflow-y-auto bg-background {isMobile ? 'pb-16' : ''}"
	onscroll={handleScroll}
	data-git-history-commit-list
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
					class="rounded border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					onclick={onBeginComparison}
				>
					{m.git_compare_select_commits()}
				</button>
			</div>
		{/if}
	</div>
	{#if error && commits.length === 0}
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
					class="group relative cursor-pointer select-none px-3 py-2 hover:bg-muted/40 {comparisonFrom ===
						commit.hash || comparisonTo === commit.hash
						? 'bg-interactive-accent/10'
						: ''}"
				>
					<button
						type="button"
						class="absolute inset-0 z-0 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent"
						aria-pressed={comparisonSelectionActive
							? comparisonFrom === commit.hash || comparisonTo === commit.hash
							: undefined}
						aria-label={comparisonSelectionActive
							? m.git_compare_select_commit_for({
									commit: commit.subject || commit.shortHash,
									endpoint:
										comparisonSelectionSlot === 'from' ? m.git_compare_from() : m.git_compare_to(),
								})
							: m.git_history_open_commit({
									commit: commit.subject || commit.shortHash,
								})}
						data-git-history-commit-row
						onclick={() =>
							comparisonSelectionActive
								? onSelectComparisonCommit(commit.hash)
								: onOpenCommit(commit.hash)}
					></button>
					<div class="pointer-events-none relative z-[1] flex items-stretch gap-2">
						<div class="min-w-0 flex-1 text-left">
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
						</div>
						<button
							type="button"
							class="pointer-events-auto self-center rounded p-1 text-muted-foreground opacity-70 hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
							title={copiedHash === commit.hash ? 'Copied commit hash' : 'Copy commit hash'}
							aria-label={copiedHash === commit.hash ? 'Copied commit hash' : 'Copy commit hash'}
							onclick={(event) => copyCommitHash(event, commit.hash)}
						>
							<Copy class="h-3.5 w-3.5" />
						</button>
						<ChevronRight class="self-center h-4 w-4 shrink-0 text-muted-foreground" />
					</div>
				</div>
			{/each}
		</div>
		{#if nextOffset !== null && (isLoading || error)}
			<div class="flex h-9 items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
				<div class="h-px flex-1 bg-border/70"></div>
				{#if isLoading}
					<div class="flex h-7 items-center gap-1.5 px-2" role="status" aria-live="polite">
						<LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
						{m.git_history_loading_more_commits()}
					</div>
				{:else if error}
					<button
						type="button"
						class="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded px-2 text-xs font-medium text-status-error-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
						onclick={onLoadMore}
					>
						<RefreshCw class="size-3.5" aria-hidden="true" />
						{m.git_history_retry_more_commits()}
					</button>
				{/if}
				<div class="h-px flex-1 bg-border/70"></div>
			</div>
		{/if}
	{/if}
</div>
