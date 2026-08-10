<script lang="ts">
	import type { SingletonSurfaceRegistry } from '$lib/workspace/singleton-surfaces.svelte.js';

	let { registry }: { registry: SingletonSurfaceRegistry } = $props();
</script>

{#if registry}
	{@const controller = registry.files()}
	<span>{controller.presentationVisible ? 'visible' : 'hidden'}</span>
	{#each controller.tree.filteredRows as row (row.key)}
		<span data-singleton-file-row={row.entry.path}>{row.entry.name}</span>
	{/each}
{/if}
