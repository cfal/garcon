<script lang="ts">
	import type { SingletonSurfaceRegistry } from '../singleton-surfaces.svelte.js';

	let { registry }: { registry: SingletonSurfaceRegistry } = $props();
</script>

{#if registry}
	{@const controller = registry.files()}
	<span>{controller.presentationVisible ? 'visible' : 'hidden'}</span>
{/if}
