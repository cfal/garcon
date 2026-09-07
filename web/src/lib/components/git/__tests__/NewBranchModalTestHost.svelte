<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import NewBranchModal from '../NewBranchModal.svelte';
	import { setTransientLayers } from '$lib/context';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';

	let props: ComponentProps<typeof NewBranchModal> = $props();
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
</script>

<NewBranchModal {...props} />
