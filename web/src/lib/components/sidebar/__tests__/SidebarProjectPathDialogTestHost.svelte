<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import SidebarProjectPathDialog from '../SidebarProjectPathDialog.svelte';
	import { setExecutionNodesTestContext } from '$lib/execution-nodes/__tests__/execution-nodes-test-context';
	import type { ExecutionNodeSnapshot } from '$shared/execution-nodes';
	let { nodes, ...props }: ComponentProps<typeof SidebarProjectPathDialog> & {
		nodes?: readonly ExecutionNodeSnapshot[];
	} = $props();
	const executionNodes = setExecutionNodesTestContext();
	$effect(() => {
		if (nodes) executionNodes.applySnapshot(nodes);
	});
</script>

<SidebarProjectPathDialog {...props} />
