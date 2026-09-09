<script lang="ts">
	import { useStore } from '@xyflow/svelte';
	import type { CanvasFlowNode } from '../canvas-node-types';
	let { onstore }: { onstore: (store: ReturnType<typeof useStore<CanvasFlowNode>>) => void } =
		$props();
	const flowStore = $derived(useStore<CanvasFlowNode>());
	$effect(() => onstore(flowStore));
</script>
