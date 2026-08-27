<script lang="ts">
	import { tick } from 'svelte';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import History from '@lucide/svelte/icons/history';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import type { GitHistoryCommitListItem } from '$lib/api/git.js';
	import type {
		GitHistoryListChange,
		GitHistoryListPosition,
	} from '$lib/git/history/git-history.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import GitCommitListRow from './GitCommitListRow.svelte';
	import { GitCommitListVirtualController } from './GitCommitListVirtualController.svelte.js';
	import {
		managedWorkspaceScrollRegion,
		scrollElementHalfPage,
	} from '$lib/workspace/workspace-scroll-region.js';

	interface GitCommitListScreenProps {
		commits: GitHistoryCommitListItem[];
		isLoading: boolean;
		error: string | null;
		nextOffset: number | null;
		isMobile: boolean;
		position: GitHistoryListPosition;
		collectionChange: GitHistoryListChange;
		onOpenCommit: (hash: string) => void;
		onLoadMore: () => void;
		onPositionSave: (position: GitHistoryListPosition) => void;
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
		position,
		collectionChange,
		onOpenCommit,
		onLoadMore,
		onPositionSave,
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
	let lastBoundarySignature: string | null = null;
	let boundaryRequestRevision: number | null = null;

	function isWithinLoadAheadRange(): boolean {
		if (!listRef || listRef.clientHeight <= 0) return false;
		const remainingDistance = listRef.scrollHeight - listRef.scrollTop - listRef.clientHeight;
		return remainingDistance <= listRef.clientHeight;
	}

	function maybeLoadMore(): void {
		if (isLoading || error || nextOffset === null || !isWithinLoadAheadRange() || !listRef) return;
		const collectionSignature =
			collectionChange.kind === 'append'
				? collectionChange.kind
				: `${collectionChange.kind}:${collectionChange.revision}`;
		const signature = `${collectionSignature}:${commits.length}:${listRef.scrollHeight}:${nextOffset}`;
		if (signature === lastBoundarySignature) return;
		lastBoundarySignature = signature;
		boundaryRequestRevision = collectionChange.revision;
		onLoadMore();
	}

	function retryLoadMore(): void {
		lastBoundarySignature = null;
		onLoadMore();
	}

	const virtual = new GitCommitListVirtualController({
		get commits() {
			return commits;
		},
		get collectionChange() {
			return collectionChange;
		},
		get viewport() {
			return listRef;
		},
		get savedPosition() {
			return position;
		},
		onPositionSave: (nextPosition) => onPositionSave(nextPosition),
		onLoadBoundaryReached: maybeLoadMore,
		onUserScrollIntent: () => {
			lastBoundarySignature = null;
		},
	});
	const primaryScrollRegion = managedWorkspaceScrollRegion('primary', (element, direction) => {
		virtual.noteUserScrollIntent();
		scrollElementHalfPage(element, direction);
	});
	let virtualSnapshot = $derived(virtual.snapshot);
	let virtualItems = $derived(virtual.renderedItems(virtualSnapshot));
	let totalHeight = $derived(virtualSnapshot.sizerSize);
	let renderedVirtualItems = $derived.by(() =>
		virtualItems.flatMap((virtualItem) => {
			const commit = virtual.commitAt(virtualItem.index);
			return commit ? [{ virtualItem, commit }] : [];
		}),
	);
	let ariaSetSize = $derived(nextOffset === null ? commits.length : -1);

	$effect(() => {
		if (isLoading || boundaryRequestRevision === null) return;
		const requestRevision = boundaryRequestRevision;
		boundaryRequestRevision = null;
		if (collectionChange.revision === requestRevision) lastBoundarySignature = null;
	});

	$effect(() => {
		const element = listRef;
		const commitCount = commits.length;
		if (!element || commitCount === 0 || isLoading || error || nextOffset === null) return;
		let cancelled = false;

		void tick().then(() => {
			if (cancelled || listRef !== element || commits.length < commitCount) return;
			virtual.maybeLoadMore();
		});

		return () => {
			cancelled = true;
		};
	});
</script>

<div class="flex min-h-0 flex-1 flex-col bg-background">
	<div class="shrink-0 border-b border-border bg-background px-3 py-2">
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

	<div
		bind:this={listRef}
		{@attach virtual.viewport}
		{@attach primaryScrollRegion}
		class="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain bg-background {isMobile
			? 'pb-16'
			: ''}"
		style:overflow-anchor="none"
		onscroll={virtual.handleScroll}
		data-git-history-commit-list
	>
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
			<div
				class="relative w-full"
				style:height={`${totalHeight}px`}
				role="list"
				aria-label={m.git_history_commits()}
				aria-busy={isLoading}
				data-git-history-virtual-spacer
				data-git-history-loaded-count={commits.length}
				{@attach virtual.sizer}
			>
				{#each renderedVirtualItems as rendered (rendered.virtualItem.key)}
					<div
						class="absolute left-0 top-0 w-full border-b border-border"
						style:transform={`translateY(${rendered.virtualItem.start}px)`}
						role="listitem"
						aria-posinset={rendered.virtualItem.index + 1}
						aria-setsize={ariaSetSize}
						data-index={rendered.virtualItem.index}
						data-git-history-virtual-row
						{@attach virtual.item(rendered.commit.hash)}
					>
						<svelte:boundary>
							<GitCommitListRow
								commit={rendered.commit}
								{comparisonSelectionActive}
								{comparisonSelectionSlot}
								selectedForComparison={comparisonFrom === rendered.commit.hash ||
									comparisonTo === rendered.commit.hash}
								active={virtual.activeHash === rendered.commit.hash}
								onActivate={() => virtual.activate(rendered.commit.hash)}
								onOpenOrSelect={() =>
									comparisonSelectionActive
										? onSelectComparisonCommit(rendered.commit.hash)
										: onOpenCommit(rendered.commit.hash)}
								onNavigate={(event) => virtual.handleRowKeydown(event, rendered.commit.hash)}
								onFocusWithinChange={(focused) => virtual.setFocused(rendered.commit.hash, focused)}
							/>
							{#snippet failed()}
								<div class="px-3 py-2 text-xs text-status-error-foreground">
									{m.git_history_row_render_failed()}
								</div>
							{/snippet}
						</svelte:boundary>
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
						<span class="min-w-0 truncate text-status-error-foreground" role="alert" title={error}
							>{error}</span
						>
						<button
							type="button"
							class="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded px-2 text-xs font-medium text-status-error-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
							onclick={retryLoadMore}
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
</div>
