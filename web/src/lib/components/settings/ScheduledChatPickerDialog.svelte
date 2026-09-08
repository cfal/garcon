<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import SidebarSearchPanel from '$lib/components/sidebar/SidebarSearchPanel.svelte';
	import { matchesChatFilter, parseChatSearch } from '$shared/chat-filter-query';
	import { getChatSessions } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		onSelect: (chatId: string) => void;
		onClose: () => void;
	}

	let { open, onSelect, onClose }: Props = $props();
	const sessions = getChatSessions();
	let query = $state('');
	let highlightedIndex = $state(0);
	let currentTime = $state(new Date());
	let filter = $derived(parseChatSearch(query));
	let filteredChats = $derived(
		sessions.orderedChats.filter(
			(chat) => chat.status !== 'draft' && matchesChatFilter(chat, filter),
		),
	);

	$effect(() => {
		if (!open) return;
		query = '';
		highlightedIndex = 0;
		currentTime = new Date();
		void sessions.quietRefreshChats();
	});

	$effect(() => {
		void filteredChats.length;
		highlightedIndex = Math.min(highlightedIndex, Math.max(filteredChats.length - 1, 0));
	});

	function selectChat(chatId: string): void {
		onSelect(chatId);
		onClose();
	}
</script>

<Dialog.Root {open} requestClose={onClose}>
	<Dialog.Content
		class="top-[var(--app-viewport-center-y)] flex h-[var(--app-height)] max-h-[var(--app-height)] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:w-screen sm:max-w-none min-[769px]:pointer-fine:top-[50%] min-[769px]:pointer-fine:h-[min(44rem,calc(var(--app-height)-2rem))] min-[769px]:pointer-fine:max-h-[44rem] min-[769px]:pointer-fine:w-[calc(100vw-2rem)] min-[769px]:pointer-fine:max-w-3xl min-[769px]:pointer-fine:rounded-2xl min-[769px]:pointer-fine:border"
		showCloseButton={false}
	>
		<Dialog.Title class="sr-only">{m.scheduled_prompts_select_chat()}</Dialog.Title>
		<SidebarSearchPanel
			{query}
			{filteredChats}
			{currentTime}
			{highlightedIndex}
			savedSearches={[]}
			onQueryChange={(value) => {
				query = value;
				highlightedIndex = 0;
			}}
			onSelectChat={selectChat}
			onApplySavedSearch={() => {}}
			onCreateSavedSearch={() => {}}
			onOpenManager={() => {}}
			onHighlightChange={(index) => (highlightedIndex = index)}
			{onClose}
			showSavedSearchActions={false}
		/>
	</Dialog.Content>
</Dialog.Root>
