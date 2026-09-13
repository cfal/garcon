<script lang="ts">
	import type { TicketDetail, TicketLinkKind } from '$shared/tickets';
	import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	let { controller, detail }: { controller: TicketsController; detail: TicketDetail } = $props();
	let target = $state('');
	let kind = $state<TicketLinkKind>('blocks');
	let pending = $state(false);
	async function link() {
		if (pending || !/^G-[1-9]\d*$/.test(target.trim())) return;
		pending = true;
		try {
			await controller.link(detail.ticket, target.trim(), kind, 'link');
		} finally {
			pending = false;
		}
	}
</script>

<details class="ticket-relationships">
	<summary>{m.tickets_related()} · {detail.links.length}</summary>
	{#each detail.links as link (`${link.kind}:${link.sourceId}:${link.targetId}`)}
		{@const other = link.sourceId === detail.ticket.id ? link.targetId : link.sourceId}
		<div class="ticket-actions">
			<span class="ticket-muted"
				>{link.kind === 'related'
					? m.tickets_related()
					: link.sourceId === detail.ticket.id
						? m.tickets_blocks()
						: m.tickets_blocked_by()}</span
			>
			<button type="button" class="ticket-text-button" onclick={() => controller.select(other)}
				>{other}</button
			>
			<button
				type="button"
				class="ticket-text-button"
				aria-label={`${m.tickets_unlink()} ${other}`}
				onclick={() => void controller.unlink(link)}>{m.tickets_remove()}</button
			>
		</div>
	{:else}<p class="ticket-muted">{m.tickets_no_links()}</p>{/each}
	<form
		class="ticket-actions"
		onsubmit={(event) => {
			event.preventDefault();
			void link();
		}}
	>
		<label class="ticket-field"
			><span class="sr-only">{m.tickets_related()}</span><select
				class="ticket-input"
				bind:value={kind}
				><option value="blocks">{m.tickets_blocks()}</option><option value="related"
					>{m.tickets_related()}</option
				></select
			></label
		>
		<label class="ticket-field"
			><span class="sr-only">{m.tickets_target()}</span><input
				class="ticket-input"
				placeholder="G-42"
				bind:value={target}
			/></label
		>
		<button class="ticket-button" disabled={pending || !/^G-[1-9]\d*$/.test(target.trim())}
			>{m.tickets_link()}</button
		>
	</form>
</details>
