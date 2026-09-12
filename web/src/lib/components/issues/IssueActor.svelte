<script lang="ts">
	import type { IssueActor } from '$shared/issues';
	import type { IssueChatSummary } from './issue-presentation.js';
	import * as m from '$lib/paraglide/messages.js';
	let {
		actor,
		chats,
		username,
		onOpenChat,
	}: {
		actor: IssueActor;
		chats: readonly IssueChatSummary[];
		username: string;
		onOpenChat: (id: string) => void;
	} = $props();
</script>

{#snippet chatLink(id: string)}
	{@const chat = chats.find((entry) => entry.id === id)}
	{#if chat}<button
			type="button"
			class="issue-text-button"
			title={id}
			onclick={() => onOpenChat(id)}
			>{chat.title || m.issues_chat({ id })} <span class="issue-id">…{id.slice(-4)}</span></button
		>
	{:else}<span title={id}>{m.issues_deleted_chat({ id })}</span>{/if}
{/snippet}
<span class="issue-actor">
	{#if actor.kind === 'chat'}{@render chatLink(actor.chatId)}
	{:else}{actor.username === username ? m.issues_you() : actor.username}
		{#if actor.declaredChatId}
			· {m.issues_declared()} {@render chatLink(actor.declaredChatId)}{/if}
	{/if}
</span>
