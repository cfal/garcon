<script lang="ts">
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import * as m from '$lib/paraglide/messages.js';
	import ChatEventCard from './ChatEventCard.svelte';

	interface Props {
		presentation: 'notice' | 'error';
		title?: string;
		content: string;
	}

	let { presentation, title, content }: Props = $props();
	const label = $derived(
		presentation === 'error' ? m.chat_message_cli_error() : m.chat_message_cli_notice(),
	);
</script>

<ChatEventCard
	variant={presentation === 'error' ? 'error' : 'info'}
	compact
	class="cli-row-message"
>
	{#snippet body()}
		<div class="flex min-w-0 items-center gap-2">
			<SquareTerminal class="size-3.5 shrink-0" aria-hidden="true" />
			{#if title}<span class="sr-only">{label}</span>{/if}
			<span class="min-w-0 flex-1 truncate text-xs font-medium">{title ?? label}</span>
		</div>
		<div class="mt-1 whitespace-pre-wrap break-words text-sm">{content}</div>
	{/snippet}
</ChatEventCard>
