<script lang="ts">
	import SidebarChatSummary from './SidebarChatSummary.svelte';
	import { cn } from '$lib/utils/cn';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarSearchResultRowProps {
		chat: ChatSessionRecord;
		index: number;
		currentTime: Date;
		isHighlighted: boolean;
		onSelectChat: (chatId: string) => void;
		onHighlightChange: (index: number) => void;
	}

	let {
		chat,
		index,
		currentTime,
		isHighlighted,
		onSelectChat,
		onHighlightChange,
	}: SidebarSearchResultRowProps = $props();
</script>

<button
	data-search-index={index}
	type="button"
	role="option"
	aria-selected={isHighlighted}
	class={cn(
		'min-w-0 w-full border-b border-border/40 border-l-2 border-l-transparent bg-transparent px-3 py-2.5 text-left font-normal transition-colors duration-150 last:border-b-0',
		isHighlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40',
		chat.isProcessing && 'border-l-[3px] border-l-status-processing',
	)}
	onclick={() => onSelectChat(chat.id)}
	onmouseenter={() => onHighlightChange(index)}
>
	<SidebarChatSummary
		session={chat}
		isSelected={isHighlighted}
		isPinned={chat.isPinned}
		isArchived={chat.isArchived}
		{currentTime}
		showTimestamp={true}
	/>
</button>
