<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import SidebarSearchDialog from '$lib/components/sidebar/SidebarSearchDialog.svelte';
	import { matchesChatFilter, parseChatSearch } from '$lib/components/sidebar/sidebar-search';
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

<Dialog.Root {open} onOpenChange={(value) => !value && onClose()}>
	<Dialog.Content
		class="h-dvh w-screen max-w-none border-0 bg-transparent p-0 shadow-none sm:max-w-none"
		showCloseButton={false}
	>
		<Dialog.Title class="sr-only">{m.scheduled_prompts_select_chat()}</Dialog.Title>
		<SidebarSearchDialog
			{open}
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
			overlayClass="z-[70]"
			contentRole="presentation"
		/>
	</Dialog.Content>
</Dialog.Root>
