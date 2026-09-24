<script lang="ts">
	import Monitor from '@lucide/svelte/icons/monitor';
	import { getExecutionNodes, hasExecutionNodes } from '$lib/context';
	let { nodeId }: { nodeId: string } = $props();
	const nodes = hasExecutionNodes() ? getExecutionNodes() : null;
</script>

<span class="inline-flex min-w-0 items-center gap-1" title={nodeId}>
	<Monitor size={12} class="shrink-0" />
	<span class="truncate">{nodes?.get(nodeId)?.label ?? nodeId}</span>
</span>
