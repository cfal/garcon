<script lang="ts">
	// Renders a cross-agent continuation boundary: a divider marking where the
	// chat was continued under a different agent with a fresh seeded session,
	// so prior tool state was not carried over.

	import ArrowRightLeft from '@lucide/svelte/icons/arrow-right-left';
	import type { AgentSwitchMessage } from '$shared/chat-types';
	import ChatEventCard from './rows/ChatEventCard.svelte';
	import { agentLabelFor } from '$lib/agents/agent-labels';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		message: AgentSwitchMessage;
	}

	let { message }: Props = $props();

	const fromLabel = $derived(agentLabelFor(message.fromAgentId));
	const toLabel = $derived(agentLabelFor(message.toAgentId));
</script>

<ChatEventCard variant="info" compact>
	{#snippet body()}
		<div class="flex flex-wrap items-center gap-2">
			<ArrowRightLeft class="h-4 w-4 flex-shrink-0" />
			<span class="text-xs font-medium">
				{m.chat_message_agent_switch({ from: fromLabel, to: toLabel })}
			</span>
			{#if message.toModel}
				<span class="text-xs text-muted-foreground">({message.toModel})</span>
			{/if}
			<span class="text-xs text-muted-foreground">{m.chat_message_agent_switch_note()}</span>
		</div>
	{/snippet}
</ChatEventCard>
