<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import SavedSearchPills from './SavedSearchPills.svelte';
	import SidebarChatSummary from './SidebarChatSummary.svelte';
	import Search from '@lucide/svelte/icons/search';
	import Settings from '@lucide/svelte/icons/settings';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { SavedChatSearch } from '$lib/api/settings';

	interface SidebarSearchDialogProps {
		open: boolean;
		query: string;
		filteredChats: ChatSessionRecord[];
		savedSearches: SavedChatSearch[];
		highlightedIndex: number;
		onQueryChange: (query: string) => void;
		onSelectChat: (chatId: string) => void;
		onApplySavedSearch: (search: SavedChatSearch) => void;
		onOpenManager: () => void;
		onHighlightChange: (index: number) => void;
		onClose: () => void;
	}

	let {
		open,
		query,
		filteredChats,
		savedSearches,
		highlightedIndex,
		onQueryChange,
		onSelectChat,
		onApplySavedSearch,
		onOpenManager,
		onHighlightChange,
		onClose,
	}: SidebarSearchDialogProps = $props();

	let inputRef = $state<HTMLInputElement | null>(null);

	function handleQueryInput(e: Event) {
		const target = e.target as HTMLInputElement;
		onQueryChange(target.value);
	}

	function handleDialogKeydown(e: KeyboardEvent) {
		const key = e.key.toLowerCase();

		if ((e.ctrlKey || e.metaKey) && key === 's') {
			e.preventDefault();
			e.stopPropagation();
			onClose();
			return;
		}

		if (e.ctrlKey && key === 'j') {
			e.preventDefault();
			onHighlightChange(Math.min(highlightedIndex + 1, filteredChats.length - 1));
			return;
		}

		if (e.ctrlKey && key === 'k') {
			e.preventDefault();
			onHighlightChange(Math.max(highlightedIndex - 1, 0));
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
			onClose();
		}
	}

	function focusInput() {
		requestAnimationFrame(() => inputRef?.focus());
	}

	function handleBackdropClick() {
		onClose();
	}

	$effect(() => {
		if (!open) return;
		focusInput();
	});

	$effect(() => {
		if (!open) return;
		const item = document.querySelector<HTMLElement>(`[data-search-index="${highlightedIndex}"]`);
		item?.scrollIntoView({ block: 'nearest' });
	});
</script>

{#if open}
	<div class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" role="presentation">
		<button
			class="absolute inset-0 h-full w-full cursor-default"
			onclick={handleBackdropClick}
			aria-label="Close search"
			tabindex="-1"
		></button>

		<div class="fixed inset-0 flex items-stretch justify-center sm:items-start sm:p-4 sm:pt-[10vh]" role="presentation">
			<div
				data-slot="search-dialog-content"
				class="flex h-dvh w-screen min-w-0 flex-col overflow-hidden bg-background shadow-2xl sm:h-[min(44rem,calc(100dvh-8rem))] sm:w-full sm:max-w-3xl sm:rounded-2xl sm:border sm:border-border"
				role="dialog"
				aria-label={m.sidebar_projects_search_placeholder()}
				aria-modal="true"
				tabindex="-1"
				onkeydown={handleDialogKeydown}
			>
				<div class="shrink-0 border-b border-border">
					<div class="flex min-w-0 items-center gap-2 px-4 py-3">
						<Search class="h-4 w-4 shrink-0 text-muted-foreground" />
						<input
							bind:this={inputRef}
							type="text"
							value={query}
							oninput={handleQueryInput}
							placeholder={m.sidebar_projects_search_placeholder()}
							class="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
						/>
						<Button
							variant="ghost"
							size="icon-sm"
							class="shrink-0"
							onclick={onOpenManager}
							title={m.sidebar_saved_searches_edit()}
							aria-label={m.sidebar_saved_searches_edit()}
						>
							<Settings class="h-4 w-4" />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							class="shrink-0"
							onclick={onClose}
							title="Close search"
							aria-label="Close search"
						>
							<X class="h-4 w-4" />
						</Button>
					</div>

					{#if savedSearches.length > 0}
						<div class="px-4 pb-4" data-slot="saved-search-pills">
							<SavedSearchPills
								searches={savedSearches}
								onApply={onApplySavedSearch}
							/>
						</div>
					{/if}
				</div>

				<div class="min-h-0 flex-1 overflow-y-auto" data-slot="search-dialog-results">
					{#if filteredChats.length === 0}
						<div class="px-4 py-10 text-center text-sm text-muted-foreground">
							{m.sidebar_chats_no_matching_chats()}
						</div>
					{:else}
						<div role="listbox">
							{#each filteredChats as chat, i (chat.id)}
								<button
									data-search-index={i}
									type="button"
									role="option"
									aria-selected={i === highlightedIndex}
									class={cn(
										'min-w-0 w-full border-b border-border/40 border-l-2 border-l-transparent bg-transparent px-3 py-2.5 text-left font-normal transition-colors duration-150 last:border-b-0',
										i === highlightedIndex
											? 'bg-accent text-accent-foreground'
											: 'hover:bg-accent/40',
										chat.isProcessing && 'border-l-[3px] border-l-status-processing',
									)}
									onclick={() => onSelectChat(chat.id)}
									onmouseenter={() => onHighlightChange(i)}
								>
									<SidebarChatSummary
										session={chat}
										isSelected={i === highlightedIndex}
										isPinned={chat.isPinned}
										isArchived={chat.isArchived}
									/>
								</button>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}
