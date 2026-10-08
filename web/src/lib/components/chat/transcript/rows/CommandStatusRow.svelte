<script lang="ts">
	import type { CommandOutputMessage, CommandResultMessage } from '$shared/chat-types';
	import type { ConversationDisclosureStatePort } from '../ConversationFeedItemState.svelte.js';
	import ChatEventCard from './ChatEventCard.svelte';
	import CollapsibleBody from './CollapsibleBody.svelte';
	import CodeBlock from '$lib/components/rich-text/CodeBlock.svelte';

	let { message, disclosureState }: {
		message: CommandOutputMessage | CommandResultMessage;
		disclosureState?: ConversationDisclosureStatePort;
	} = $props();
</script>

{#if message.type === 'command-output'}
	<div class="text-xs font-medium text-muted-foreground">stderr</div>
	<CodeBlock text={message.content} />
{:else}
	<ChatEventCard variant="neutral" compact>
		{#snippet body()}
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
{/if}
