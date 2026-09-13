<script lang="ts">
	import type { TicketChatSummary } from './ticket-presentation.js';
	import * as m from '$lib/paraglide/messages.js';
	let {
		chatId,
		chats,
		onOpenChat,
	}: {
		chatId: string;
		chats: readonly TicketChatSummary[];
		onOpenChat: (id: string) => void;
	} = $props();
	const chat = $derived(chats.find((entry) => entry.id === chatId));
</script>

{#if chat}<button
		type="button"
		class="ticket-text-button"
		title={chatId}
		onclick={() => onOpenChat(chatId)}
		>{chat.title || m.tickets_chat({ id: chatId })}
		<span class="ticket-id">…{chatId.slice(-4)}</span></button
	>
{:else}<span title={chatId}>{m.tickets_deleted_chat({ id: chatId })}</span>{/if}
