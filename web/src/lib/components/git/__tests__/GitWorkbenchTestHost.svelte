<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import GitWorkbench from '../GitWorkbench.svelte';
	import { setWorkspaceShortcuts, setTransientLayers } from '$lib/context';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';

	let props: ComponentProps<typeof GitWorkbench> = $props();
	setWorkspaceShortcuts({
		registerSurface: () => () => {},
	} as never);
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
</script>

<GitWorkbench {...props} />
