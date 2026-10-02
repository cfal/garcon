<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { setTransientLayers } from '$lib/context';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import DirectoryBrowser from '$lib/components/project-paths/DirectoryBrowser.svelte';
	let props: ComponentProps<typeof DirectoryBrowser> = $props();
	const executorId = $derived(props.executorId);
	const executorContextKey = $derived(props.executorContextKey);
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
</script>

<DirectoryBrowser {...props} {executorId} {executorContextKey} />
