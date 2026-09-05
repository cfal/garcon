<script lang="ts">
	import { tick, untrack } from 'svelte';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import * as m from '$lib/paraglide/messages.js';
	import { FixedVirtualWindow } from '$lib/components/virtual/fixed-virtual-window.svelte';
	import SidebarSearchResultRow from './SidebarSearchResultRow.svelte';
	import {
		SEARCH_RESULT_ROW_HEIGHT,
		SEARCH_RESULTS_OVERSCAN,
		SEARCH_RESULTS_VIRTUALIZATION_THRESHOLD,
	} from './sidebar-search-results';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatSearchResult } from '$shared/chat-search';

	interface SidebarSearchResultsProps {
		filteredChats: ChatSessionRecord[];
		transcriptMatchesByChatId?: Map<string, ChatSearchResult>;
		currentTime: Date;
		highlightedIndex: number;
		highlightRevealVersion?: number;
		resultsResetVersion?: number;
		revalidationVersion?: number;
		showTranscriptPagination?: boolean;
		hasMoreTranscriptResults?: boolean;
		loadingMoreTranscriptResults?: boolean;
		transcriptSearchPageError?: string | null;
		transcriptSearchRevalidating?: boolean;
		transcriptSearchRevalidationError?: string | null;
		transcriptSearchLimitReached?: boolean;
		transcriptSearchAnnouncement?: string;
		transcriptSearchAnnouncementVersion?: number;
		onSelectChat: (chatId: string) => void;
		onHighlightChange: (index: number) => void;
		onLoadMoreTranscriptResults?: () => Promise<void> | void;
		onRetryTranscriptSearchRevalidation?: () => Promise<void> | void;
	}

	let {
		filteredChats,
		transcriptMatchesByChatId = new Map(),
		currentTime,
		highlightedIndex,
		highlightRevealVersion = 0,
		resultsResetVersion = 0,
		revalidationVersion = 0,
		showTranscriptPagination = false,
		hasMoreTranscriptResults = false,
		loadingMoreTranscriptResults = false,
		transcriptSearchPageError = null,
		transcriptSearchRevalidating = false,
		transcriptSearchRevalidationError = null,
		transcriptSearchLimitReached = false,
		transcriptSearchAnnouncement = '',
		transcriptSearchAnnouncementVersion = 0,
		onSelectChat,
		onHighlightChange,
		onLoadMoreTranscriptResults,
		onRetryTranscriptSearchRevalidation,
	}: SidebarSearchResultsProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);
	let sentinelRef = $state<HTMLElement | null>(null);
	let sentinelObserver: IntersectionObserver | null = null;
	let paginationWasBusy = false;
	let previousChatIds: string[] = [];
	let pendingAnchor: { chatId: string; offset: number; scrollTop: number } | null = null;
	let useVirtualResults = $derived(filteredChats.length > SEARCH_RESULTS_VIRTUALIZATION_THRESHOLD);
	let resultsBusy = $derived(
		loadingMoreTranscriptResults || transcriptSearchRevalidating,
	);
	let footerLabel = $derived.by(() => {
		if (transcriptSearchRevalidating) return m.sidebar_search_updating_results();
		if (transcriptSearchRevalidationError) return m.sidebar_search_retry_update();
		if (loadingMoreTranscriptResults) return m.sidebar_search_loading_more();
		if (transcriptSearchPageError) return m.sidebar_search_retry_more();
		if (transcriptSearchLimitReached) return m.sidebar_search_limit_reached();
		if (hasMoreTranscriptResults) return m.sidebar_search_load_more();
		return m.sidebar_search_all_loaded();
	});
	let footerActionable = $derived(
		Boolean(transcriptSearchRevalidationError || transcriptSearchPageError || hasMoreTranscriptResults)
			&& !resultsBusy,
	);
	const virtualWindow = new FixedVirtualWindow({
		get itemCount() {
			return filteredChats.length;
		},
		get rowHeight() {
			return SEARCH_RESULT_ROW_HEIGHT;
		},
		get overscan() {
			return SEARCH_RESULTS_OVERSCAN;
		},
		get viewportRef() {
			return viewportRef;
		},
		defaultViewportHeight: 560,
	});
	let visibleResults = $derived.by(() =>
		virtualWindow.visibleIndexes
			.map((index) => ({ index, chat: filteredChats[index] }))
			.filter((entry): entry is { index: number; chat: ChatSessionRecord } => Boolean(entry.chat)),
	);

	function scrollHighlightedIntoView(targetIndex: number, virtualResults: boolean): void {
		if (filteredChats.length === 0) return;

		if (!virtualResults) {
			if (targetIndex <= 0 && viewportRef) {
				viewportRef.scrollTop = 0;
			}
			const item = viewportRef?.querySelector<HTMLElement>(
				`[data-search-index="${targetIndex}"]`,
			);
			item?.scrollIntoView({ block: 'nearest' });
			return;
		}

		virtualWindow.scrollIndexIntoView(targetIndex);
	}

	function requestFooterAction(): Promise<void> {
		if (!showTranscriptPagination || !footerActionable) return Promise.resolve();
		if (transcriptSearchRevalidationError) {
			return Promise.resolve(onRetryTranscriptSearchRevalidation?.());
		}
		return Promise.resolve(onLoadMoreTranscriptResults?.());
	}

	function canLoadAutomatically(): boolean {
		return showTranscriptPagination
			&& hasMoreTranscriptResults
			&& !resultsBusy
			&& !transcriptSearchPageError
			&& !transcriptSearchRevalidationError;
	}

	function loadAutomatically(): void {
		if (!canLoadAutomatically()) return;
		void requestFooterAction();
	}

	function refreshSentinelIntersection(): void {
		if (!sentinelObserver || !sentinelRef) return;
		sentinelObserver.unobserve(sentinelRef);
		sentinelObserver.observe(sentinelRef);
	}

	function handleFooterClick(): void {
		if (!footerActionable) return;
		void requestFooterAction();
	}

	$effect(() => {
		return virtualWindow.bindViewport();
	});

	// Tracks browser-owned viewport metrics that Svelte cannot derive.
	$effect(() => {
		return virtualWindow.observeViewport();
	});

	$effect(() => {
		highlightRevealVersion;
		const targetIndex = untrack(() => highlightedIndex);
		const virtualResults = untrack(() => useVirtualResults);
		let active = true;
		const frame = requestAnimationFrame(() => {
			if (!active) return;
			scrollHighlightedIntoView(targetIndex, virtualResults);
		});
		return () => {
			active = false;
			cancelAnimationFrame(frame);
		};
	});

	$effect(() => {
		resultsResetVersion;
		const viewport = untrack(() => viewportRef);
		if (viewport) viewport.scrollTop = 0;
	});

	$effect(() => {
		const viewport = viewportRef;
		const sentinel = sentinelRef;
		if (!viewport || !sentinel || typeof IntersectionObserver === 'undefined') return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) loadAutomatically();
		}, {
			root: viewport,
			rootMargin: `0px 0px ${SEARCH_RESULT_ROW_HEIGHT * 6}px 0px`,
		});
		sentinelObserver = observer;
		observer.observe(sentinel);
		return () => {
			if (sentinelObserver === observer) sentinelObserver = null;
			observer.disconnect();
		};
	});

	// Re-observes after external page or revalidation work so geometry is measured again.
	$effect(() => {
		if (resultsBusy) {
			paginationWasBusy = true;
			return;
		}
		if (!paginationWasBusy) return;
		paginationWasBusy = false;
		if (canLoadAutomatically()) refreshSentinelIntersection();
	});

	$effect.pre(() => {
		revalidationVersion;
		const viewport = untrack(() => viewportRef);
		if (!viewport || previousChatIds.length === 0) return;
		const index = Math.min(
			previousChatIds.length - 1,
			Math.max(0, Math.floor(viewport.scrollTop / SEARCH_RESULT_ROW_HEIGHT)),
		);
		pendingAnchor = {
			chatId: previousChatIds[index],
			offset: viewport.scrollTop - index * SEARCH_RESULT_ROW_HEIGHT,
			scrollTop: viewport.scrollTop,
		};
	});

	$effect(() => {
		filteredChats;
		revalidationVersion;
		void tick().then(() => {
			const viewport = viewportRef;
			const anchor = pendingAnchor;
			if (viewport && anchor) {
				const index = filteredChats.findIndex((chat) => chat.id === anchor.chatId);
				viewport.scrollTop = index >= 0
					? index * SEARCH_RESULT_ROW_HEIGHT + anchor.offset
					: anchor.scrollTop;
			}
			pendingAnchor = null;
			previousChatIds = filteredChats.map((chat) => chat.id);
		});
	});
</script>

<div
	bind:this={viewportRef}
	class="min-h-0 flex-1 overflow-y-auto"
	data-slot="search-dialog-results"
	aria-busy={resultsBusy}
>
	{#if filteredChats.length === 0}
		<div class="px-4 py-10 text-center text-sm text-muted-foreground">
			{m.sidebar_chats_no_matching_chats()}
		</div>
	{:else if useVirtualResults}
		<div
			role="listbox"
			class="relative"
			style={`height:${virtualWindow.totalHeight}px;`}
			data-search-dialog-virtual-list
		>
			{#each visibleResults as entry (entry.chat.id)}
				<div
					class="absolute left-0 right-0 top-0 overflow-hidden"
					style={`height:${SEARCH_RESULT_ROW_HEIGHT}px; transform:translateY(${virtualWindow.getOffset(entry.index)}px);`}
					data-search-dialog-virtual-row={entry.chat.id}
				>
					<svelte:boundary>
						<SidebarSearchResultRow
							chat={entry.chat}
							index={entry.index}
							transcriptMatch={transcriptMatchesByChatId.get(entry.chat.id)}
							{currentTime}
							isHighlighted={entry.index === highlightedIndex}
							{onSelectChat}
							{onHighlightChange}
						/>
						{#snippet failed()}
							<div
								class="flex h-full items-center border-b border-border px-3 text-sm text-muted-foreground"
							>
								{entry.chat.title || m.sidebar_chats_unnamed()}
							</div>
						{/snippet}
					</svelte:boundary>
					<div
						class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border"
						aria-hidden="true"
						data-search-dialog-row-separator
					></div>
				</div>
			{/each}
		</div>
	{:else}
		<div role="listbox" class="divide-y divide-border">
			{#each filteredChats as chat, index (chat.id)}
				<svelte:boundary>
					<SidebarSearchResultRow
						{chat}
						{index}
						transcriptMatch={transcriptMatchesByChatId.get(chat.id)}
						{currentTime}
						isHighlighted={index === highlightedIndex}
						{onSelectChat}
						{onHighlightChange}
					/>
					{#snippet failed()}
						<div class="px-3 py-2.5 text-sm text-muted-foreground">
							{chat.title || m.sidebar_chats_unnamed()}
						</div>
					{/snippet}
				</svelte:boundary>
			{/each}
		</div>
	{/if}
	{#if showTranscriptPagination && onLoadMoreTranscriptResults}
		<div bind:this={sentinelRef} class="flex min-h-16 items-center justify-center px-4 py-3">
			<button
				type="button"
				class="inline-flex min-h-9 items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				aria-disabled={!footerActionable}
				onclick={handleFooterClick}
			>
				{#if resultsBusy}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{/if}
				{footerLabel}
			</button>
		</div>
	{/if}
	<div role="status" aria-atomic="true" class="sr-only">
		{#key transcriptSearchAnnouncementVersion}
			<span>{transcriptSearchAnnouncement}</span>
		{/key}
	</div>
</div>
