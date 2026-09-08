<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuGroup,
		DropdownMenuGroupHeading,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn.js';
	import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import Save from '@lucide/svelte/icons/save';
	import Search from '@lucide/svelte/icons/search';
	import Settings from '@lucide/svelte/icons/settings';
	import X from '@lucide/svelte/icons/x';
	import SavedSearchPills from './SavedSearchPills.svelte';
	import SidebarSearchHelpDialog from './SidebarSearchHelpDialog.svelte';
	import SidebarSearchResults from './SidebarSearchResults.svelte';
	import SidebarTranscriptSearchStatus from './SidebarTranscriptSearchStatus.svelte';
	import type { SidebarSearchPanelProps } from './sidebar-search-panel';
	import type { ChatSearchSort } from '$shared/chat-search';

	let {
		query,
		filteredChats,
		savedSearches,
		transcriptMatchesByChatId = new Map(),
		transcriptSearchEnabled = false,
		transcriptSearchLoading = false,
		transcriptSearchIndexing = false,
		transcriptSearchIndex = null,
		transcriptSearchStatus = null,
		transcriptSearchError = null,
		sort = 'relevance',
		showTranscriptPagination = false,
		hasMoreTranscriptResults = false,
		loadingMoreTranscriptResults = false,
		transcriptSearchPageError = null,
		transcriptSearchRevalidating = false,
		transcriptSearchRevalidationError = null,
		transcriptSearchLimitReached = false,
		transcriptSearchAnnouncement = '',
		transcriptSearchAnnouncementVersion = 0,
		resultsResetVersion = 0,
		revalidationVersion = 0,
		currentTime,
		highlightedIndex,
		onQueryChange,
		onSelectChat,
		onApplySavedSearch,
		onCreateSavedSearch,
		onOpenManager,
		onHighlightChange,
		onRetryTranscriptSearch = () => {},
		onSortChange,
		onLoadMoreTranscriptResults,
		onRetryTranscriptSearchRevalidation,
		onClose,
		showSavedSearchActions = true,
		reduceMotion = false,
	}: SidebarSearchPanelProps = $props();

	let inputRef = $state<HTMLInputElement | null>(null);
	let helpDialogOpen = $state(false);
	let highlightRevealVersion = $state(0);
	let trimmedQuery = $derived(query.trim());
	let canCreateSavedSearch = $derived(trimmedQuery.length > 0);

	function handleQueryInput(event: Event): void {
		onQueryChange((event.target as HTMLInputElement).value);
	}

	function sortLabel(value: ChatSearchSort): string {
		switch (value) {
			case 'relevance':
				return m.sidebar_search_sort_relevance();
			case 'activity':
				return m.sidebar_search_sort_activity();
			case 'created':
				return m.sidebar_search_sort_created();
		}
	}

	function sortTriggerLabel(value: ChatSearchSort): string {
		return `${m.sidebar_search_sort_heading()}: ${sortLabel(value)}`;
	}

	function moveHighlight(offset: -1 | 1): void {
		if (filteredChats.length === 0) return;
		const currentIndex = Math.min(Math.max(highlightedIndex, 0), filteredChats.length - 1);
		const nextIndex = Math.min(Math.max(currentIndex + offset, 0), filteredChats.length - 1);
		onHighlightChange(nextIndex);
		highlightRevealVersion += 1;
		const canPrefetchTranscriptResults =
			hasMoreTranscriptResults && !transcriptSearchPageError && !transcriptSearchRevalidationError;
		if (offset > 0 && canPrefetchTranscriptResults && nextIndex >= filteredChats.length - 8) {
			void onLoadMoreTranscriptResults?.();
		}
	}

	function handlePanelKeydown(event: KeyboardEvent): void {
		const key = event.key.toLowerCase();
		if ((event.ctrlKey || event.metaKey) && key === 's') {
			event.preventDefault();
			event.stopPropagation();
			onClose();
			return;
		}

		if ((event.target === inputRef && key === 'arrowdown') || (event.ctrlKey && key === 'j')) {
			event.preventDefault();
			moveHighlight(1);
			return;
		}

		if ((event.target === inputRef && key === 'arrowup') || (event.ctrlKey && key === 'k')) {
			event.preventDefault();
			moveHighlight(-1);
			return;
		}

		if (key !== 'enter' || event.target !== inputRef) return;
		event.preventDefault();
		const selected = filteredChats[highlightedIndex];
		if (selected) onSelectChat(selected.id);
	}

	function focusInput(): void {
		requestAnimationFrame(() => inputRef?.focus());
	}

	function clearQuery(): void {
		onQueryChange('');
		focusInput();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	data-slot="search-dialog-panel"
	class={cn(
		'flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background',
		reduceMotion && 'sidebar-reduce-motion',
	)}
	onkeydown={handlePanelKeydown}
>
	<div class="shrink-0 border-b border-border">
		<div
			class="flex min-w-0 flex-col gap-2 px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] min-[769px]:pointer-fine:flex-row min-[769px]:pointer-fine:items-center min-[769px]:pointer-fine:py-3"
		>
			<div class="flex min-w-0 items-center gap-2 min-[769px]:pointer-fine:contents">
				<div
					data-slot="search-dialog-input-shell"
					class="relative h-11 min-w-0 flex-1 rounded-lg border border-sidebar-border/70 bg-muted/50 text-foreground transition-colors focus-within:border-border focus-within:bg-background min-[769px]:pointer-fine:h-9"
				>
					<Search
						class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
					/>
					<input
						bind:this={inputRef}
						type="text"
						value={query}
						oninput={handleQueryInput}
						placeholder={m.sidebar_projects_search_placeholder()}
						class="h-full w-full rounded-[inherit] bg-transparent pl-9 pr-11 text-base leading-6 text-foreground placeholder:text-muted-foreground outline-none min-[769px]:pointer-fine:text-sm min-[769px]:pointer-fine:leading-5"
					/>
					{#if query.length > 0}
						<button
							type="button"
							class="absolute inset-y-0 right-0 inline-flex w-11 items-center justify-center rounded-r-[inherit] text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
							onclick={clearQuery}
							aria-label={m.filetree_clear_search()}
							title={m.filetree_clear_search()}
						>
							<X class="h-4 w-4" />
						</button>
					{/if}
				</div>
				<Button
					variant="ghost"
					size="icon"
					class="h-11 w-11 shrink-0 rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:bg-background hover:text-foreground min-[769px]:pointer-fine:order-last min-[769px]:pointer-fine:h-9 min-[769px]:pointer-fine:w-9"
					onclick={onClose}
					title={m.sidebar_search_close()}
					aria-label={m.sidebar_search_close()}
				>
					<X class="h-4 w-4" />
				</Button>
			</div>

			<div class="flex items-center justify-end gap-2 min-[769px]:pointer-fine:contents">
				{#if onSortChange}
					<DropdownMenu>
						<DropdownMenuTrigger
							class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-[769px]:pointer-fine:h-9 min-[769px]:pointer-fine:w-9"
							aria-label={sortTriggerLabel(sort)}
							title={sortTriggerLabel(sort)}
						>
							<ArrowUpDown class="h-4 w-4" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuGroup>
								<DropdownMenuGroupHeading>
									{m.sidebar_search_sort_heading()}
								</DropdownMenuGroupHeading>
								<DropdownMenuRadioGroup
									value={sort}
									onValueChange={(value) => onSortChange(value as ChatSearchSort)}
								>
									<DropdownMenuRadioItem value="relevance">
										{m.sidebar_search_sort_relevance()}
									</DropdownMenuRadioItem>
									<DropdownMenuRadioItem value="activity">
										{m.sidebar_search_sort_activity()}
									</DropdownMenuRadioItem>
									<DropdownMenuRadioItem value="created">
										{m.sidebar_search_sort_created()}
									</DropdownMenuRadioItem>
								</DropdownMenuRadioGroup>
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				{/if}

				<Button
					variant="ghost"
					size="icon"
					class="h-11 w-11 shrink-0 rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:bg-background hover:text-foreground min-[769px]:pointer-fine:h-9 min-[769px]:pointer-fine:w-9"
					onclick={() => (helpDialogOpen = true)}
					title={m.sidebar_search_legend_help()}
					aria-label={m.sidebar_search_legend_help()}
				>
					<CircleHelp class="h-4 w-4" />
				</Button>

				{#if showSavedSearchActions}
					<Button
						variant="ghost"
						size="icon"
						class="h-11 w-11 shrink-0 rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:bg-background hover:text-foreground min-[769px]:pointer-fine:h-9 min-[769px]:pointer-fine:w-9"
						onclick={onCreateSavedSearch}
						title={m.sidebar_saved_searches_add()}
						aria-label={m.sidebar_saved_searches_add()}
						disabled={!canCreateSavedSearch}
					>
						<Save class="h-4 w-4" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						class="h-11 w-11 shrink-0 rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:bg-background hover:text-foreground min-[769px]:pointer-fine:h-9 min-[769px]:pointer-fine:w-9"
						onclick={onOpenManager}
						title={m.sidebar_saved_searches_manage_menu_item()}
						aria-label={m.sidebar_saved_searches_manage_menu_item()}
					>
						<Settings class="h-4 w-4" />
					</Button>
				{/if}
			</div>
		</div>

		{#if showSavedSearchActions && savedSearches.length > 0}
			<div class="px-4 pb-4" data-slot="saved-search-pills">
				<SavedSearchPills searches={savedSearches} onApply={onApplySavedSearch} />
			</div>
		{/if}
	</div>

	<SidebarTranscriptSearchStatus
		enabled={transcriptSearchEnabled}
		loading={transcriptSearchLoading}
		indexing={transcriptSearchIndexing}
		index={transcriptSearchIndex}
		status={transcriptSearchStatus}
		error={transcriptSearchError}
		onRetry={onRetryTranscriptSearch}
	/>

	<SidebarSearchResults
		{filteredChats}
		{transcriptMatchesByChatId}
		{currentTime}
		{highlightedIndex}
		{highlightRevealVersion}
		{resultsResetVersion}
		{revalidationVersion}
		{showTranscriptPagination}
		{hasMoreTranscriptResults}
		{loadingMoreTranscriptResults}
		{transcriptSearchPageError}
		{transcriptSearchRevalidating}
		{transcriptSearchRevalidationError}
		{transcriptSearchLimitReached}
		{transcriptSearchAnnouncement}
		{transcriptSearchAnnouncementVersion}
		{onSelectChat}
		{onHighlightChange}
		{onLoadMoreTranscriptResults}
		{onRetryTranscriptSearchRevalidation}
	/>
</div>

<SidebarSearchHelpDialog open={helpDialogOpen} onOpenChange={(open) => (helpDialogOpen = open)} />
