<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils/cn.js';
	import SavedSearchPills from './SavedSearchPills.svelte';
	import SidebarSearchResults from './SidebarSearchResults.svelte';
	import SidebarTranscriptSearchStatus from './SidebarTranscriptSearchStatus.svelte';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import Search from '@lucide/svelte/icons/search';
	import Save from '@lucide/svelte/icons/save';
	import Settings from '@lucide/svelte/icons/settings';
	import X from '@lucide/svelte/icons/x';
	import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
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
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { SavedChatSearch } from '$lib/api/settings';
	import type {
		ChatSearchIndexStatus,
		ChatSearchResult,
		ChatSearchSort,
		TranscriptSearchStatusV1,
	} from '$shared/chat-search';

	interface SidebarSearchDialogProps {
		open: boolean;
		query: string;
		filteredChats: ChatSessionRecord[];
		savedSearches: SavedChatSearch[];
		transcriptMatchesByChatId?: Map<string, ChatSearchResult>;
		transcriptSearchEnabled?: boolean;
		transcriptSearchLoading?: boolean;
		transcriptSearchIndexing?: boolean;
		transcriptSearchIndex?: ChatSearchIndexStatus | null;
		transcriptSearchStatus?: TranscriptSearchStatusV1 | null;
		transcriptSearchError?: string | null;
		sort?: ChatSearchSort;
		showTranscriptPagination?: boolean;
		hasMoreTranscriptResults?: boolean;
		loadingMoreTranscriptResults?: boolean;
		transcriptSearchPageError?: string | null;
		transcriptSearchRevalidating?: boolean;
		transcriptSearchRevalidationError?: string | null;
		transcriptSearchLimitReached?: boolean;
		transcriptSearchAnnouncement?: string;
		transcriptSearchAnnouncementVersion?: number;
		resultsResetVersion?: number;
		revalidationVersion?: number;
		currentTime: Date;
		highlightedIndex: number;
		onQueryChange: (query: string) => void;
		onSelectChat: (chatId: string) => void;
		onApplySavedSearch: (search: SavedChatSearch) => void;
		onCreateSavedSearch: () => void;
		onOpenManager: () => void;
		onHighlightChange: (index: number) => void;
		onRetryTranscriptSearch?: () => void;
		onSortChange?: (sort: ChatSearchSort) => void;
		onLoadMoreTranscriptResults?: () => Promise<void> | void;
		onRetryTranscriptSearchRevalidation?: () => Promise<void> | void;
		onClose: () => void;
		showSavedSearchActions?: boolean;
		reduceMotion?: boolean;
		overlayClass?: string;
		backdropTreatment?: 'standard' | 'interaction-only';
		contentRole?: 'dialog' | 'presentation';
	}

	let {
		open,
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
		overlayClass,
		backdropTreatment = 'standard',
		contentRole = 'dialog',
	}: SidebarSearchDialogProps = $props();

	let inputRef = $state<HTMLInputElement | null>(null);
	let dialogRef = $state<HTMLDivElement | null>(null);
	let helpDialogOpen = $state(false);
	let highlightRevealVersion = $state(0);
	let trimmedQuery = $derived(query.trim());
	let canCreateSavedSearch = $derived(trimmedQuery.length > 0);

	function handleQueryInput(e: Event) {
		const target = e.target as HTMLInputElement;
		onQueryChange(target.value);
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

	function moveHighlight(offset: -1 | 1) {
		if (filteredChats.length === 0) return;
		const currentIndex = Math.min(Math.max(highlightedIndex, 0), filteredChats.length - 1);
		const nextIndex = Math.min(Math.max(currentIndex + offset, 0), filteredChats.length - 1);
		onHighlightChange(nextIndex);
		highlightRevealVersion += 1;
		const canPrefetchTranscriptResults = hasMoreTranscriptResults
			&& !transcriptSearchPageError
			&& !transcriptSearchRevalidationError;
		if (offset > 0 && canPrefetchTranscriptResults && nextIndex >= filteredChats.length - 8) {
			void onLoadMoreTranscriptResults?.();
		}
	}

	function isVisibleFocusableElement(element: HTMLElement): boolean {
		if (element.hidden) return false;
		const style = window.getComputedStyle(element);
		return style.display !== 'none' && style.visibility !== 'hidden';
	}

	function trapDialogFocus(e: KeyboardEvent): boolean {
		if (contentRole !== 'dialog' || e.key !== 'Tab' || !dialogRef) return false;
		const focusable = Array.from(
			dialogRef.querySelectorAll<HTMLElement>(
				'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
			),
		).filter(isVisibleFocusableElement);
		if (focusable.length === 0) {
			e.preventDefault();
			return true;
		}
		const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
		const atBoundary =
			currentIndex === -1 || (e.shiftKey ? currentIndex === 0 : currentIndex === focusable.length - 1);
		if (!atBoundary) return false;
		e.preventDefault();
		focusable[e.shiftKey ? focusable.length - 1 : 0]?.focus();
		return true;
	}

	function handleDialogKeydown(e: KeyboardEvent) {
		if (trapDialogFocus(e)) return;
		const key = e.key.toLowerCase();

		if ((e.ctrlKey || e.metaKey) && key === 's') {
			e.preventDefault();
			e.stopPropagation();
			onClose();
			return;
		}

		if ((e.target === inputRef && key === 'arrowdown') || (e.ctrlKey && key === 'j')) {
			e.preventDefault();
			moveHighlight(1);
			return;
		}

		if ((e.target === inputRef && key === 'arrowup') || (e.ctrlKey && key === 'k')) {
			e.preventDefault();
			moveHighlight(-1);
			return;
		}

		if (key === 'enter') {
			if (e.target !== inputRef) return;
			e.preventDefault();
			const selected = filteredChats[highlightedIndex];
			if (selected) onSelectChat(selected.id);
			return;
		}

		if (key === 'escape') {
			e.preventDefault();
			e.stopPropagation();
			onClose();
		}
	}

	function focusInput() {
		requestAnimationFrame(() => inputRef?.focus());
	}

	function clearQuery() {
		onQueryChange('');
		focusInput();
	}

	function handleBackdropClick() {
		onClose();
	}

	function handleContainerClick(event: MouseEvent) {
		if (event.target !== event.currentTarget) return;
		onClose();
	}

	$effect(() => {
		if (!open) return;
		focusInput();
	});
</script>

{#if open}
	<div
		class={cn(
			'fixed inset-0 z-50',
			backdropTreatment === 'standard' && 'transient-backdrop',
			reduceMotion && 'sidebar-reduce-motion',
			overlayClass,
		)}
		role="presentation"
	>
		<button
			class="absolute inset-0 h-full w-full cursor-default"
			onclick={handleBackdropClick}
			aria-label={m.editor_actions_close()}
			tabindex="-1"
		></button>

		<div
			class="fixed inset-0 flex items-stretch justify-center sm:items-start sm:p-4 sm:pt-[10vh]"
			role="presentation"
			onclick={handleContainerClick}
		>
			<div
				bind:this={dialogRef}
				data-slot="search-dialog-content"
				class="flex h-dvh w-screen min-w-0 flex-col overflow-hidden bg-background shadow-2xl sm:h-[min(44rem,calc(100dvh-8rem))] sm:w-full sm:max-w-3xl sm:rounded-2xl sm:border sm:border-border"
				role={contentRole}
				aria-label={contentRole === 'dialog' ? m.sidebar_projects_search_placeholder() : undefined}
				aria-modal={contentRole === 'dialog' ? 'true' : undefined}
				tabindex="-1"
				onkeydown={handleDialogKeydown}
			>
				<div class="shrink-0 border-b border-border">
					<div class="flex min-w-0 items-center gap-2 px-4 py-3">
						<div
							data-slot="search-dialog-input-shell"
							class="relative h-9 min-w-0 flex-1 rounded-lg border border-sidebar-border/70 bg-muted/50 text-sm text-foreground transition-colors focus-within:border-border focus-within:bg-background"
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
								class="h-full w-full rounded-[inherit] bg-transparent pl-9 pr-8 text-base leading-6 text-foreground placeholder:text-muted-foreground outline-none sm:pointer-fine:text-sm sm:pointer-fine:leading-5"
							/>
							{#if query.length > 0}
								<button
									type="button"
									class="absolute right-2 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
									onclick={clearQuery}
									aria-label={m.filetree_clear_search()}
									title={m.filetree_clear_search()}
								>
									<X class="h-3 w-3" />
								</button>
							{/if}
						</div>
						{#if onSortChange}
							<DropdownMenu>
								<DropdownMenuTrigger
									class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-sidebar-border/70 bg-muted/50 px-2.5 text-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
								>
									<ArrowUpDown class="h-3.5 w-3.5" />
									<span class="sr-only sm:not-sr-only">{sortLabel(sort)}</span>
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
							size="icon-sm"
							class="h-9 w-9 shrink-0 rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:bg-background hover:text-foreground"
							onclick={() => (helpDialogOpen = true)}
							title={m.sidebar_search_legend_help()}
							aria-label={m.sidebar_search_legend_help()}
						>
							<CircleHelp class="h-4 w-4" />
						</Button>

						{#if showSavedSearchActions}
							<Button
								variant="ghost"
								size="icon-sm"
								class="h-9 w-9 shrink-0 rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:bg-background hover:text-foreground"
								onclick={onCreateSavedSearch}
								title={m.sidebar_saved_searches_add()}
								aria-label={m.sidebar_saved_searches_add()}
								disabled={!canCreateSavedSearch}
							>
								<Save class="h-4 w-4" />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								class="h-9 w-9 shrink-0 rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:bg-background hover:text-foreground"
								onclick={onOpenManager}
								title={m.sidebar_saved_searches_manage_menu_item()}
								aria-label={m.sidebar_saved_searches_manage_menu_item()}
							>
								<Settings class="h-4 w-4" />
							</Button>
						{/if}
						<Button
							variant="ghost"
							size="icon-sm"
							class="h-9 w-9 shrink-0 rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:bg-background hover:text-foreground sm:hidden"
							onclick={onClose}
							title={m.sidebar_search_close()}
							aria-label={m.sidebar_search_close()}
						>
							<X class="h-4 w-4" />
						</Button>
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
		</div>
	</div>
	<Dialog.Root open={helpDialogOpen} onOpenChange={(v) => (helpDialogOpen = v)}>
		<Dialog.Content
			class="h-dvh w-full max-w-full rounded-none border-0 p-6 sm:h-auto sm:rounded-lg sm:border"
		>
			<Dialog.Header>
				<Dialog.Title>{m.sidebar_search_legend_help()}</Dialog.Title>
				<p class="text-sm text-muted-foreground">
					{m.sidebar_search_legend_description()}
				</p>
			</Dialog.Header>
			<div class="space-y-2 text-sm">
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
						>Any text</code
					>
					<span class="text-muted-foreground"
						>{m.sidebar_search_legend_free_text_description()}</span
					>
				</div>
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
						>title:X</code
					>
					<span class="text-muted-foreground">{m.sidebar_search_legend_title()}</span>
				</div>
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground">tag:X</code
					>
					<span class="text-muted-foreground">{m.sidebar_search_legend_tag()}</span>
				</div>
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
						>agent:X</code
					>
					<span class="text-muted-foreground">{m.sidebar_search_legend_agent()}</span>
				</div>
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
						>model:X</code
					>
					<span class="text-muted-foreground">{m.sidebar_search_legend_model()}</span>
				</div>
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
						>status:X</code
					>
					<span class="text-muted-foreground">{m.sidebar_search_legend_status()}</span>
				</div>
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground">is:X</code>
					<span class="text-muted-foreground">{m.sidebar_search_legend_order_group()}</span>
				</div>
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
						>project:X</code
					>
					<span class="text-muted-foreground">{m.sidebar_search_legend_project()}</span>
				</div>
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
						>tag:X project:Y</code
					>
					<span class="text-muted-foreground">{m.sidebar_search_legend_combine()}</span>
				</div>
			</div>
			<Dialog.Footer>
				<Button onclick={() => (helpDialogOpen = false)}>{m.editor_actions_close()}</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}
