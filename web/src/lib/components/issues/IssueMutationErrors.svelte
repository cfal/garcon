<script lang="ts">
	import type { IssueDraftState } from '$lib/issues/drafts/issue-draft-state.svelte.js';
	import IssueDraftFeedback from './IssueDraftFeedback.svelte';
	let { drafts }: { drafts: readonly IssueDraftState[] } = $props();
</script>

{#each drafts.filter((draft) => draft.current.kind === 'mutation' && draft.error) as draft (draft.current.id)}
	<IssueDraftFeedback {draft} />
{/each}
