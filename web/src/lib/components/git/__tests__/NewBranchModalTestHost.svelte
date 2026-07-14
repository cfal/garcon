<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import NewBranchModal from '../NewBranchModal.svelte';
	import { setTransientLayers } from '$lib/context';
	import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';

	let props: ComponentProps<typeof NewBranchModal> = $props();
	setTransientLayers(new TransientLayerRegistry(new ChatInteractionGate()));
</script>

<NewBranchModal {...props} />
