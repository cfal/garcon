<script lang="ts">
	import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';

	interface Props {
		rows: readonly ChatDisplayRow[];
	}

	let { rows }: Props = $props();
</script>

<div data-conversation-transcript>
	{#each rows as row (row.id)}
		<div data-transcript-row-id={row.id}></div>
	{/each}
</div>
