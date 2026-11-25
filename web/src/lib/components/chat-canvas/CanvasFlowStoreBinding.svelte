<script lang="ts">
	import { useStore } from '@xyflow/svelte';
	import type { CanvasFlowNode } from './canvas-node-types';

	let { onReady }: { onReady: (store: ReturnType<typeof useStore<CanvasFlowNode>>) => void } =
		$props();
	// The parent provider still holds a placeholder when CanvasFlow initializes.
	const store = useStore<CanvasFlowNode>();
	$effect(() => onReady(store));
</script>
