<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import GitDiffViewer from '../GitDiffViewer.svelte';
	import { setTransientLayers } from '$lib/context';
	import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';

	let props: ComponentProps<typeof GitDiffViewer> = $props();
	setTransientLayers(new TransientLayerRegistry(new ChatInteractionGate()));
</script>

<GitDiffViewer {...props} />
