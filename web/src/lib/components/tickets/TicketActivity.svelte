<script lang="ts">
	import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
	import type { TicketSource } from '$shared/tickets';
	import { ticketActivityLabel, type TicketChatSummary } from './ticket-presentation.js';
	import TicketActor from './TicketActor.svelte';
	import TicketMarkdown from './TicketMarkdown.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		chats,
		username,
		onOpenChat,
		onOpenSource,
	}: {
		controller: TicketsController;
		chats: readonly TicketChatSummary[];
		username: string;
		onOpenChat: (id: string) => void;
		onOpenSource: (source: TicketSource) => void;
	} = $props();
</script>

<p class="ticket-notice">{m.tickets_history_warning()}</p>
{#if controller.detail.historyError}<div class="ticket-notice" role="alert">
		<p>{controller.detail.historyError}</p>
		<button
			class="ticket-button"
			disabled={!!controller.pagePending}
			onclick={() => void controller.loadHistory()}>{m.tickets_retry()}</button
		>
	</div>{/if}
{#if controller.detail.history?.nextBeforeSequence !== null && controller.detail.history}<button
		class="ticket-button"
		disabled={!!controller.pagePending}
		onclick={() => void controller.loadOlderHistory()}>{m.tickets_older_activity()}</button
	>{/if}
<ol class="ticket-activity">
	{#each controller.detail.history?.items ?? [] as entry (entry.sequence)}
		<svelte:boundary>
			<li>
				<p>
					<TicketActor actor={entry.actor} {chats} {username} {onOpenChat} />
					{ticketActivityLabel(entry.action)}
				</p>
				<time class="ticket-muted" datetime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
				{#if 'changes' in entry}<dl class="ticket-changes">
						{#each entry.changes as change (change.field)}<dt>{change.field}</dt>
							<dd>
								<span>{JSON.stringify(change.before)}</span> →
								<span>{JSON.stringify(change.after)}</span>
							</dd>{/each}
					</dl>
				{:else if 'commentId' in entry}<details>
						<summary>{m.tickets_details()}</summary>{#if entry.before !== null}<h4>
								{m.tickets_before()}
							</h4>
							<TicketMarkdown text={entry.before} />{/if}{#if entry.after !== null}<h4>
								{m.tickets_after()}
							</h4>
							<TicketMarkdown text={entry.after} />{/if}
					</details>
				{:else if 'targetId' in entry}<p>{entry.sourceId} → {entry.targetId} · {entry.kind}</p>{/if}
				{#if entry.source}<p class="ticket-muted">
						{m.tickets_source_address({
							chat: entry.source.chatId,
							view: entry.source.transcriptViewId,
							ordinal: entry.source.ordinal,
						})}
						<button
							class="ticket-button"
							disabled={!chats.some((chat) => chat.id === entry.source?.chatId)}
							onclick={() => {
								if (entry.source) onOpenSource(entry.source);
							}}>{m.tickets_open_source()}</button
						>
					</p>{/if}
			</li>
			{#snippet failed()}<li class="ticket-notice">{m.tickets_invalid_entry()}</li>{/snippet}
		</svelte:boundary>
	{:else}{#if !controller.detail.historyError}<li class="ticket-muted">
				{controller.pagePending ? m.tickets_loading() : m.tickets_no_activity()}
			</li>{/if}{/each}
</ol>
