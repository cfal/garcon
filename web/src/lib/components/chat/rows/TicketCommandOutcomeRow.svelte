<script lang="ts">
	import type { TicketCommandOutcome } from '$shared/garcon-ticket-result';
	import { ticketCommandNoticeParts } from '$shared/ticket-command-notice';
	import { ticketHref } from '$lib/tickets/catalog/ticket-deep-link.js';
	import * as m from '$lib/paraglide/messages.js';
	import ChatEventCard from './ChatEventCard.svelte';

	let {
		detail,
		onOpenTicket,
	}: {
		detail: TicketCommandOutcome;
		onOpenTicket?: (id: string) => Promise<void>;
	} = $props();
	const parts = $derived(ticketCommandNoticeParts(detail));
	let navigationError = $state<string | null>(null);

	function open(event: MouseEvent, id: string): void {
		if (
			!onOpenTicket ||
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey
		)
			return;
		event.preventDefault();
		event.stopPropagation();
		navigationError = null;
		void onOpenTicket(id).catch((error: unknown) => {
			navigationError = error instanceof Error ? error.message : m.workspace_open_failed();
		});
	}
</script>

<ChatEventCard variant={detail.status === 'error' ? 'error' : 'info'} compact>
	{#snippet body()}
		<div class="text-sm whitespace-pre-wrap break-words" data-ticket-command={detail.command}>
			{#each parts as part, index (index)}
				{#if part.kind === 'ticket'}
					{#if onOpenTicket}
						<a
							href={ticketHref(part.ticketId)}
							class="text-primary font-medium underline decoration-primary/40 underline-offset-2 hover:decoration-primary focus-visible:outline-2 focus-visible:outline-ring"
							data-ticket-reference-id={part.ticketId}
							onclick={(event) => open(event, part.ticketId)}
							onpointerdowncapture={(event) => event.stopPropagation()}
							oncontextmenu={(event) => event.stopPropagation()}>{part.ticketId}</a
						>
					{:else}
						<span class="font-medium">{part.ticketId}</span>
					{/if}
				{:else if part.kind === 'code'}
					<code class="rounded bg-muted px-1 font-mono text-[0.9em] [overflow-wrap:anywhere]"
						>{part.text}</code
					>
				{:else}{part.text}{/if}
			{/each}
		</div>
		{#if navigationError}
			<p role="alert" class="mt-1 text-sm text-status-error-foreground">{navigationError}</p>
		{/if}
	{/snippet}
</ChatEventCard>
