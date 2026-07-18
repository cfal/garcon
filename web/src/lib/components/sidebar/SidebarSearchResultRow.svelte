<script lang="ts">
	import SidebarChatSummary from './SidebarChatSummary.svelte';
	import { cn } from '$lib/utils/cn';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatSearchResult, ChatSearchSnippetRole } from '$shared/chat-search';
	import { SEARCH_RESULT_ROW_HEIGHT } from './sidebar-search-results';

	interface SidebarSearchResultRowProps {
		chat: ChatSessionRecord;
		index: number;
		transcriptMatch?: ChatSearchResult;
		currentTime: Date;
		isHighlighted: boolean;
		onSelectChat: (chatId: string) => void;
		onHighlightChange: (index: number) => void;
	}

	let {
		chat,
		index,
		transcriptMatch,
		currentTime,
		isHighlighted,
		onSelectChat,
		onHighlightChange,
	}: SidebarSearchResultRowProps = $props();

	let firstTranscriptSnippet = $derived(transcriptMatch?.snippets[0] ?? null);

	function roleLabel(role: ChatSearchSnippetRole): string {
		if (role === 'user') return 'User';
		if (role === 'assistant') return 'Assistant';
		if (role === 'tool') return 'Tool';
		return 'System';
	}
</script>

<button
	data-search-index={index}
	type="button"
	role="option"
	aria-selected={isHighlighted}
	class={cn(
		'h-full min-w-0 w-full border-l-2 border-l-transparent bg-transparent px-3 py-1.5 text-left font-normal transition-colors duration-150',
		isHighlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40',
		chat.isProcessing && 'border-l-[3px] border-l-status-processing',
	)}
	style={`min-height:${SEARCH_RESULT_ROW_HEIGHT}px;`}
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
	{#if firstTranscriptSnippet}
		<div
			class={cn(
				'mt-1.5 flex min-w-0 items-center gap-1.5 text-[12px] leading-[1.25]',
				isHighlighted ? 'text-accent-foreground/80' : 'text-muted-foreground',
			)}
			data-slot="transcript-search-snippet"
		>
			<span
				class={cn(
					'shrink-0 rounded border px-1 py-0 text-[10px] font-medium uppercase',
					isHighlighted
						? 'border-accent-foreground/20 text-accent-foreground/75'
						: 'border-border text-muted-foreground',
				)}>{roleLabel(firstTranscriptSnippet.role)}</span
			>
			<span class="min-w-0 truncate">{firstTranscriptSnippet.text}</span>
		</div>
	{/if}
</button>
