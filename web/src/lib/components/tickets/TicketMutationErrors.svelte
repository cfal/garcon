<script lang="ts">
	import type { TicketDraftState } from '$lib/tickets/drafts/ticket-draft-state.svelte.js';
	import TicketDraftFeedback from './TicketDraftFeedback.svelte';
	let { drafts }: { drafts: readonly TicketDraftState[] } = $props();
</script>

{#each drafts.filter((draft) => draft.current.kind === 'mutation' && draft.error) as draft (draft.current.id)}
	<TicketDraftFeedback {draft} />
{/each}
