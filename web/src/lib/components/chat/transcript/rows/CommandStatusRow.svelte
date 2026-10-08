<script lang="ts">
	import type { CommandOutputMessage, CommandResultMessage } from '$shared/chat-types';
	import type { ConversationDisclosureStatePort } from '../ConversationFeedItemState.svelte.js';
	import ChatEventCard from './ChatEventCard.svelte';
	import CollapsibleBody from './CollapsibleBody.svelte';

	let { message, disclosureState }: {
		message: CommandOutputMessage | CommandResultMessage;
		disclosureState?: ConversationDisclosureStatePort;
	} = $props();
</script>

<ChatEventCard variant="neutral" compact>
	{#snippet body()}
		{#if message.type === 'command-output'}
			<div class="text-xs font-medium text-muted-foreground">stderr</div>
		{/if}
		<CollapsibleBody
			disclosure="collapsed"
			expanded={disclosureState?.open('cli-body', 'body', false)}
			onExpandedChange={disclosureState
				? (expanded) => disclosureState.setOpen('cli-body', 'body', expanded, false)
				: undefined}
		>
			<pre class="whitespace-pre-wrap break-words font-mono text-sm">{message.content}</pre>
		</CollapsibleBody>
	{/snippet}
</ChatEventCard>
