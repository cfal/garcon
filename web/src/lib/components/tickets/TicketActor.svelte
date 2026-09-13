<script lang="ts">
	import type { TicketActor } from '$shared/tickets';
	import type { TicketChatSummary } from './ticket-presentation.js';
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

{#snippet chatLink(id: string)}
	{@const chat = chats.find((entry) => entry.id === id)}
	{#if chat}<button
			type="button"
			class="ticket-text-button"
			title={id}
			onclick={() => onOpenChat(id)}
			>{chat.title || m.tickets_chat({ id })} <span class="ticket-id">…{id.slice(-4)}</span></button
		>
	{:else}<span title={id}>{m.tickets_deleted_chat({ id })}</span>{/if}
{/snippet}
<span class="ticket-actor">
	{#if actor.kind === 'chat'}{@render chatLink(actor.chatId)}
	{:else}{actor.username === username ? m.tickets_you() : actor.username}
		{#if actor.declaredChatId}
			· {m.tickets_declared()} {@render chatLink(actor.declaredChatId)}{/if}
	{/if}
</span>
