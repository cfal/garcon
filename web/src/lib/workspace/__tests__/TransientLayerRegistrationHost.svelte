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

	$effect(() => {
		onRun();
		return layers.register({
			id: 'effect-owned-dialog',
			kind: 'application-dialog',
			modality: 'main-inert',
			element: () => element,
			onEscape: () => true,
			restoreFocus: () => undefined,
		});
	});
</script>

<div bind:this={element}></div>
