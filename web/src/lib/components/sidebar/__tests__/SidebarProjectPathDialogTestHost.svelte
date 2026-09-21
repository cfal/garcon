<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import SidebarProjectPathDialog from '../SidebarProjectPathDialog.svelte';
	import { setExecutionNodesTestContext } from '$lib/execution-nodes/__tests__/execution-nodes-test-context';
	setExecutionNodesTestContext();
	let props: ComponentProps<typeof SidebarProjectPathDialog> = $props();
</script>

<SidebarProjectPathDialog {...props} />
