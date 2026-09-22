<script lang="ts">
	import { untrack, type ComponentProps } from 'svelte';
	import GitTargetDialog from '../GitTargetDialog.svelte';
	import { setExecutionNodesTestContext } from '$lib/execution-nodes/__tests__/execution-nodes-test-context.js';
	import type { ExecutionNodeSnapshot } from '$shared/execution-nodes';
	import type { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
	let {
		nodes,
		onNodes,
		...props
	}: ComponentProps<typeof GitTargetDialog> & {
		nodes?: readonly ExecutionNodeSnapshot[];
		onNodes?: (store: ExecutionNodesStore) => void;
	} = $props();
	untrack(() => {
		const store = setExecutionNodesTestContext(nodes);
		onNodes?.(store);
	});
</script>

<GitTargetDialog {...props} />
