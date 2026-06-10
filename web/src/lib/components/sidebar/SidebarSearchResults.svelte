<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { FixedVirtualWindow } from '$lib/components/virtual/fixed-virtual-window.svelte';
	import SidebarSearchResultRow from './SidebarSearchResultRow.svelte';
	import {
		SEARCH_RESULT_ROW_HEIGHT,
		SEARCH_RESULTS_OVERSCAN,
		SEARCH_RESULTS_VIRTUALIZATION_THRESHOLD,
	} from './sidebar-search-results';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarSearchResultsProps {
		filteredChats: ChatSessionRecord[];
		currentTime: Date;
		highlightedIndex: number;
		onSelectChat: (chatId: string) => void;
		onHighlightChange: (index: number) => void;
	}

	let {
		filteredChats,
		currentTime,
		highlightedIndex,
		onSelectChat,
		onHighlightChange,
	}: SidebarSearchResultsProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);
	let useVirtualResults = $derived(
		filteredChats.length > SEARCH_RESULTS_VIRTUALIZATION_THRESHOLD
	);
	const virtualWindow = new FixedVirtualWindow({
		get itemCount() { return filteredChats.length; },
		get rowHeight() { return SEARCH_RESULT_ROW_HEIGHT; },
		get overscan() { return SEARCH_RESULTS_OVERSCAN; },
		get viewportRef() { return viewportRef; },
		defaultViewportHeight: 560,
	});
	let visibleResults = $derived.by(() =>
		virtualWindow.visibleIndexes
			.map((index) => ({ index, chat: filteredChats[index] }))
			.filter((entry): entry is { index: number; chat: ChatSessionRecord } => Boolean(entry.chat))
	);

	function scrollHighlightedIntoView(): void {
		if (filteredChats.length === 0) return;

		if (!useVirtualResults) {
			if (highlightedIndex <= 0 && viewportRef) {
				viewportRef.scrollTop = 0;
			}
			const item = viewportRef?.querySelector<HTMLElement>(`[data-search-index="${highlightedIndex}"]`);
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
							{currentTime}
							isHighlighted={entry.index === highlightedIndex}
							{onSelectChat}
							{onHighlightChange}
						/>
						{#snippet failed()}
							<div class="flex h-full items-center border-b border-border/40 px-3 text-sm text-muted-foreground">
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
						{currentTime}
						isHighlighted={index === highlightedIndex}
						{onSelectChat}
						{onHighlightChange}
					/>
					{#snippet failed()}
						<div class="border-b border-border/40 px-3 py-2.5 text-sm text-muted-foreground">
							{chat.title || m.sidebar_chats_unnamed()}
						</div>
					{/snippet}
				</svelte:boundary>
			{/each}
		</div>
	{/if}
</div>
