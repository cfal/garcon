<script lang="ts">
	import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';

	interface Props {
		rows: readonly ChatDisplayRow[];
	}

	let { rows }: Props = $props();
</script>

{#each rows as row (row.id)}
	<div data-transcript-row-id={row.id}></div>
{/each}
