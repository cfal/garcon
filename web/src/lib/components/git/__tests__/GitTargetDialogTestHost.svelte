<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import GitTargetDialog from '../GitTargetDialog.svelte';
	import { setExecutionNodesTestContext } from '$lib/execution-nodes/__tests__/execution-nodes-test-context.js';
	let props: ComponentProps<typeof GitTargetDialog> = $props();
	setExecutionNodesTestContext();
</script>

<GitTargetDialog {...props} />
