<script lang="ts">
	import type { CommandOutputMessage, CommandResultMessage } from '$shared/chat-types';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import { commandResultPresentation } from '$lib/chat/transcript/command-result-presentation.js';
	import ChatEventCard from './ChatEventCard.svelte';
	import CodeBlock from '$lib/components/rich-text/CodeBlock.svelte';

	let { message }: {
		message: CommandOutputMessage | CommandResultMessage;
	} = $props();
	const presentation = $derived(message.type === 'command-result' ? commandResultPresentation(message.result) : null);
</script>

{#if message.type === 'command-output'}
	<div class="text-xs font-medium text-muted-foreground">stderr</div>
	<CodeBlock text={message.content} />
{:else if presentation && presentation !== 'hidden'}
	<ChatEventCard variant={presentation} compact>
		{#snippet body()}
			<div class="flex min-w-0 items-center gap-2 text-xs font-medium">
				<CircleAlert class="size-3.5 shrink-0" />
				<span class="min-w-0 whitespace-pre-wrap break-words">{message.content}</span>
			</div>
		{/snippet}
	</ChatEventCard>
{/if}
