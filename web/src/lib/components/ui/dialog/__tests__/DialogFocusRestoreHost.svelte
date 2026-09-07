<script lang="ts">
	import { setTransientLayers } from '$lib/context';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import * as Dialog from '../index.js';

	const transientLayers = new TransientLayerRegistry(new WorkspaceInteractionGate());
	setTransientLayers(transientLayers);
	let { claimFocusOnClose = false }: { claimFocusOnClose?: boolean } = $props();
	let open = $state(false);
	let outsideFocusTarget: HTMLButtonElement;

	function handleCloseAutoFocus(event: Event): void {
		event.preventDefault();
		if (claimFocusOnClose) outsideFocusTarget.focus();
	}
</script>

<svelte:window onkeydowncapture={(event) => transientLayers.handleEscape(event)} />

<Dialog.Root bind:open>
	<Dialog.Trigger>Open focus dialog</Dialog.Trigger>
	<Dialog.Content showCloseButton={false} onCloseAutoFocus={handleCloseAutoFocus}>
		<Dialog.Title>Focus restore dialog</Dialog.Title>
		<button type="button">Dialog action</button>
	</Dialog.Content>
</Dialog.Root>

<button type="button" bind:this={outsideFocusTarget}>Outside focus target</button>
