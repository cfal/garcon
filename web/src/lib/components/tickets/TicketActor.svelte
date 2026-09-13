<script lang="ts">
	import type { TicketActor } from '$shared/tickets';
	import type { TicketChatSummary } from './ticket-presentation.js';
	import TicketChatReference from './TicketChatReference.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		actor,
		chats,
		username,
		onOpenChat,
	}: {
		actor: TicketActor;
		chats: readonly TicketChatSummary[];
		username: string;
		onOpenChat: (id: string) => void;
	} = $props();
</script>

<span class="ticket-actor">
	{#if actor.kind === 'chat'}
		<TicketChatReference chatId={actor.chatId} {chats} {onOpenChat} />
	{:else}{actor.username === username ? m.tickets_you() : actor.username}
		{#if actor.declaredChatId}
			· {m.tickets_declared()}
			<TicketChatReference chatId={actor.declaredChatId} {chats} {onOpenChat} />{/if}
	{/if}
</span>
