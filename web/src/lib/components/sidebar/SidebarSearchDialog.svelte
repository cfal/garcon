<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import Input from '$lib/components/ui/input/input.svelte';
	import SavedSearchPills from './SavedSearchPills.svelte';
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

	function formatPreview(chat: ChatSessionRecord): string {
		if (chat.lastMessage) return chat.lastMessage;
		if (chat.firstMessage) return chat.firstMessage;
		return '';
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
					<Input
						bind:ref={inputRef}
						type="text"
						value={query}
						oninput={handleQueryInput}
						placeholder={m.sidebar_projects_search_placeholder()}
						class="h-9 flex-1 border-0 bg-transparent pl-1 pr-0 text-sm shadow-none focus-visible:ring-0"
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

					<div class="px-4 pb-4">
						<SavedSearchPills
							searches={savedSearches}
							onApply={onApplySavedSearch}
						/>
					</div>
				</div>

				<div class="min-h-0 flex-1 overflow-y-auto" data-slot="search-dialog-results">
					{#if filteredChats.length === 0}
						<div class="px-4 py-10 text-center text-sm text-muted-foreground">
							{m.sidebar_chats_no_matching_chats()}
						</div>
					{:else}
						<div class="p-2 sm:p-3" role="listbox">
							{#each filteredChats as chat, i (chat.id)}
								<button
									data-search-index={i}
									type="button"
									role="option"
									aria-selected={i === highlightedIndex}
									class={cn(
										'flex min-w-0 w-full flex-col gap-1 rounded-xl px-3 py-3 text-left transition-colors',
										i === highlightedIndex
											? 'bg-accent text-accent-foreground'
											: 'hover:bg-accent/50',
									)}
									onclick={() => onSelectChat(chat.id)}
									onmouseenter={() => onHighlightChange(i)}
								>
									<div class="flex min-w-0 items-center gap-2">
										<span class="min-w-0 flex-1 truncate text-sm font-medium">
											{chat.title || m.sidebar_chats_unnamed()}
										</span>
										<span class="shrink-0 text-[10px] text-muted-foreground">
											{chat.provider}
										</span>
									</div>
									{#if formatPreview(chat)}
										<span class="block min-w-0 truncate text-xs text-muted-foreground">
											{formatPreview(chat)}
										</span>
									{/if}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}
