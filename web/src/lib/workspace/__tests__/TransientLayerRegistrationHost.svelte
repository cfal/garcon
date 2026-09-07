<script lang="ts">
	import type { TransientLayerRegistry } from '../transient-layers.svelte.js';

	let {
		layers,
		onRun,
	}: {
		layers: TransientLayerRegistry;
		onRun: () => void;
	} = $props();
	let element: HTMLDivElement;
	let layerOpen = $state(true);
	const isOpen = () => layerOpen;

	$effect(() => {
		onRun();
		return layers.register({
			id: 'effect-owned-dialog',
			kind: 'application-dialog',
			modality: 'main-inert',
			isOpen,
			element: () => element,
			onEscape: () => true,
			restoreFocus: () => undefined,
		});
	});
</script>

<button data-testid="close-layer" onclick={() => (layerOpen = false)}>Close</button>
<div bind:this={element}></div>
<output data-testid="main-inert">{String(layers.makesMainInert)}</output>
