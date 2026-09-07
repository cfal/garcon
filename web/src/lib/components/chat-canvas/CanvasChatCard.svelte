<script lang="ts">
	import ChatSummary from '../shared/ChatSummary.svelte';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import * as m from '$lib/paraglide/messages.js';
	let { chat, currentTime }: { chat: ChatSessionRecord | undefined; currentTime: Date } = $props();
</script>

<div class="min-w-0 overflow-hidden px-3 py-2" data-canvas-chat-card={chat?.id ?? 'unavailable'}>
	{#if chat}
		<ChatSummary
			session={chat}
			isSelected={false}
			suppressUnread={false}
			{currentTime}
			showTimestamp
			chatItemLayout="default"
		/>
		{#if chat.isArchived}<span class="text-xs text-muted-foreground"
				>{m.chat_map_status_archived()}</span
			>{/if}
	{:else}
		<p class="text-sm font-medium">{m.canvas_unavailable_chat()}</p>
		<p class="mt-1 text-xs text-muted-foreground">{m.canvas_unavailable_description()}</p>
	{/if}
</div>
