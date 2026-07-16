<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { FixedVirtualWindow } from '$lib/components/virtual/fixed-virtual-window.svelte';
	import SidebarSearchResultRow from './SidebarSearchResultRow.svelte';
	import { Button } from '$lib/components/ui/button';
	import {
		SEARCH_RESULT_ROW_HEIGHT,
		SEARCH_RESULTS_OVERSCAN,
		SEARCH_RESULTS_VIRTUALIZATION_THRESHOLD,
	} from './sidebar-search-results';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatSearchIndexStatus, ChatSearchResult } from '$shared/chat-search';

	interface SidebarSearchResultsProps {
		filteredChats: ChatSessionRecord[];
		transcriptMatchesByChatId?: Map<string, ChatSearchResult>;
		transcriptSearchEnabled?: boolean;
		transcriptSearchLoading?: boolean;
		transcriptSearchIndexing?: boolean;
		transcriptSearchIndex?: ChatSearchIndexStatus | null;
		transcriptSearchError?: string | null;
		currentTime: Date;
		highlightedIndex: number;
		onSelectChat: (chatId: string) => void;
		onHighlightChange: (index: number) => void;
		onRetryTranscriptSearch?: () => void;
	}

	let {
		filteredChats,
		transcriptMatchesByChatId = new Map(),
		transcriptSearchEnabled = false,
		transcriptSearchLoading = false,
		transcriptSearchIndexing = false,
		transcriptSearchIndex = null,
		transcriptSearchError = null,
		currentTime,
		highlightedIndex,
		onSelectChat,
		onHighlightChange,
		onRetryTranscriptSearch = () => {},
	}: SidebarSearchResultsProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);
	let useVirtualResults = $derived(filteredChats.length > SEARCH_RESULTS_VIRTUALIZATION_THRESHOLD);
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
	let hasPendingTranscripts = $derived(
		Boolean(transcriptSearchIndex && transcriptSearchIndex.pendingChatCount > 0),
	);
	let failedTranscriptCount = $derived(transcriptSearchIndex?.failedChatCount ?? 0);
	let unsupportedTranscriptCount = $derived(transcriptSearchIndex?.unsupportedChatCount ?? 0);
	let transcriptStatusText = $derived.by(() => {
		if (transcriptSearchLoading) return m.sidebar_search_transcript_searching();
		if (hasPendingTranscripts && transcriptSearchIndex) {
			return m.sidebar_search_transcript_indexing_progress({
				indexed: transcriptSearchIndex.indexedChatCount,
				pending: transcriptSearchIndex.pendingChatCount,
			});
		}
		if (transcriptSearchIndexing) return m.sidebar_search_transcript_indexing();
		if (transcriptSearchIndex) {
			return m.sidebar_search_transcript_ready_indexed({
				count: transcriptSearchIndex.indexedChatCount,
			});
		}
		return m.sidebar_search_transcript_ready();
	});

	function scrollHighlightedIntoView(): void {
		if (filteredChats.length === 0) return;

		if (!useVirtualResults) {
			if (highlightedIndex <= 0 && viewportRef) {
				viewportRef.scrollTop = 0;
			}
			const item = viewportRef?.querySelector<HTMLElement>(
				`[data-search-index="${highlightedIndex}"]`,
			);
			item?.scrollIntoView({ block: 'nearest' });
			return;
		}

		virtualWindow.scrollIndexIntoView(highlightedIndex);
	}

	$effect(() => {
		return virtualWindow.bindViewport();
	});

	// Tracks browser-owned viewport metrics that Svelte cannot derive.
	$effect(() => {
		return virtualWindow.observeViewport();
	});

	$effect(() => {
		filteredChats;
		highlightedIndex;
		const frame = requestAnimationFrame(() => {
			scrollHighlightedIntoView();
		});
		return () => cancelAnimationFrame(frame);
	});
</script>

<div
	bind:this={viewportRef}
	class="min-h-0 flex-1 overflow-y-auto"
	data-slot="search-dialog-results"
>
	{#if transcriptSearchEnabled && transcriptSearchError}
		<div
			class="flex items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs text-destructive"
			role="alert"
		>
			<span>{transcriptSearchError}</span>
			<Button variant="outline" size="sm" onclick={onRetryTranscriptSearch}>
				{m.common_retry()}
			</Button>
		</div>
	{:else if transcriptSearchEnabled}
		<div
			class="flex h-8 items-center border-b border-border px-4 text-xs text-muted-foreground"
			data-slot="transcript-search-status"
			role="status"
			aria-live="polite"
		>
			{transcriptStatusText}
		</div>
	{/if}
	{#if transcriptSearchEnabled && !transcriptSearchError && (failedTranscriptCount > 0 || unsupportedTranscriptCount > 0)}
		<div class="border-b border-border px-4 py-2 text-xs text-muted-foreground" role="status">
			{#if failedTranscriptCount > 0}
				<span>{m.sidebar_search_transcript_failed({ count: failedTranscriptCount })}</span>
			{/if}
			{#if failedTranscriptCount > 0 && unsupportedTranscriptCount > 0}
				<span> </span>
			{/if}
			{#if unsupportedTranscriptCount > 0}
				<span>{m.sidebar_search_transcript_unsupported({ count: unsupportedTranscriptCount })}</span>
			{/if}
		</div>
	{/if}
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
				</div>
			{/each}
		</div>
	{:else}
		<div role="listbox">
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
						<div class="border-b border-border px-3 py-2.5 text-sm text-muted-foreground">
							{chat.title || m.sidebar_chats_unnamed()}
						</div>
					{/snippet}
				</svelte:boundary>
			{/each}
		</div>
	{/if}
</div>
