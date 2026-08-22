<script lang="ts">
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import type { UserMessagePresentation } from '$shared/chat-types';
	import * as m from '$lib/paraglide/messages.js';

	let { presentation }: { presentation: UserMessagePresentation } = $props();
	const label = $derived(
		presentation.style === 'error' ? m.chat_message_cli_error() : m.chat_message_cli_notice(),
	);
</script>

<div
	class={[
		'mb-1.5 flex min-w-0 items-center gap-1.5 border-b pb-1 text-xs font-medium',
		presentation.style === 'error'
			? 'border-status-error-border text-status-error-foreground'
			: 'border-status-info-border text-status-info-foreground',
	]}
	data-user-message-presentation={presentation.style}
>
	<SquareTerminal class="size-3.5 shrink-0" aria-hidden="true" />
	<span class="shrink-0">{label}</span>
	{#if presentation.title}
		<span aria-hidden="true">·</span>
		<span class="min-w-0 truncate">{presentation.title}</span>
	{/if}
</div>
