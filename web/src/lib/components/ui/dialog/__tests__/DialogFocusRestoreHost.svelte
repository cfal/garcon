<script lang="ts">
	import { setTransientLayers } from '$lib/context';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import * as Dialog from '../index.js';

	const transientLayers = new TransientLayerRegistry(new WorkspaceInteractionGate());
	setTransientLayers(transientLayers);
	let open = $state(false);
</script>

<svelte:window onkeydowncapture={(event) => transientLayers.handleEscape(event)} />

<Dialog.Root bind:open>
	<Dialog.Trigger>Open focus dialog</Dialog.Trigger>
	<Dialog.Content
		showCloseButton={false}
		onCloseAutoFocus={(event) => event.preventDefault()}
	>
		<Dialog.Title>Focus restore dialog</Dialog.Title>
		<button type="button">Dialog action</button>
	</Dialog.Content>
</Dialog.Root>
