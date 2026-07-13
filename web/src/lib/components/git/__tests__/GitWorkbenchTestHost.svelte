<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import GitWorkbench from '../GitWorkbench.svelte';
	import { setWorkspaceShortcuts, setTransientLayers } from '$lib/context';
	import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';

	let props: ComponentProps<typeof GitWorkbench> = $props();
	setWorkspaceShortcuts({
		registerSurface: () => () => {},
	} as never);
	setTransientLayers(new TransientLayerRegistry(new ChatInteractionGate()));
</script>

<GitWorkbench {...props} />
