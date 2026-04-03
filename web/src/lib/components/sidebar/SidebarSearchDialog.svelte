<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import Input from '$lib/components/ui/input/input.svelte';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import SavedSearchPills from './SavedSearchPills.svelte';
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

	function handleOpenChange(nextOpen: boolean) {
		if (!nextOpen) onClose();
	}

	function handleQueryInput(e: Event) {
		const target = e.target as HTMLInputElement;
		onQueryChange(target.value);
	}

	function handleDialogKeydown(e: KeyboardEvent) {
		const key = e.key.toLowerCase();

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

	function formatPreview(chat: ChatSessionRecord): string {
		if (chat.lastMessage) return chat.lastMessage;
		if (chat.firstMessage) return chat.firstMessage;
		return '';
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="h-dvh w-full max-w-full rounded-none border-0 p-0 gap-0 sm:h-auto sm:max-h-[85vh] sm:max-w-2xl sm:rounded-lg sm:border"
		onOpenAutoFocus={(e) => { e.preventDefault(); focusInput(); }}
		onkeydown={handleDialogKeydown}
	>
		<div class="flex items-center gap-2 border-b border-border p-3">
			<Input
				bind:ref={inputRef}
				type="text"
				value={query}
				oninput={handleQueryInput}
				placeholder={m.sidebar_projects_search_placeholder()}
				class="flex-1 border-0 shadow-none focus-visible:ring-0 h-9 text-sm"
			/>
			<Button variant="outline" size="sm" onclick={onOpenManager}>
				{m.sidebar_saved_searches_edit()}
			</Button>
		</div>

		<div class="px-3 pt-3">
			<SavedSearchPills
				searches={savedSearches}
				onApply={onApplySavedSearch}
			/>
		</div>

		<ScrollArea class="flex-1 min-h-0 max-h-[calc(100dvh-8rem)] p-1 sm:max-h-[60vh]">
			{#if filteredChats.length === 0}
				<div class="px-3 py-8 text-center text-sm text-muted-foreground">
					{m.sidebar_chats_no_matching_chats()}
				</div>
			{:else}
				{#each filteredChats as chat, i (chat.id)}
					<button
						type="button"
						class={cn(
							'w-full text-left px-3 py-2 rounded-md flex flex-col gap-0.5 transition-colors',
							i === highlightedIndex
								? 'bg-accent text-accent-foreground'
								: 'hover:bg-accent/50',
						)}
						onclick={() => onSelectChat(chat.id)}
						onmouseenter={() => onHighlightChange(i)}
					>
						<div class="flex items-center gap-2">
							<span class="text-sm font-medium truncate flex-1">
								{chat.title || m.sidebar_chats_unnamed()}
							</span>
							<span class="text-[10px] text-muted-foreground shrink-0">
								{chat.provider}
							</span>
						</div>
						{#if formatPreview(chat)}
							<span class="text-xs text-muted-foreground truncate">
								{formatPreview(chat)}
							</span>
						{/if}
					</button>
				{/each}
			{/if}
		</ScrollArea>
	</Dialog.Content>
</Dialog.Root>
