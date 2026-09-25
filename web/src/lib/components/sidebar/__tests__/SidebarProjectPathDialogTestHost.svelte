<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import SidebarProjectPathDialog from '../SidebarProjectPathDialog.svelte';
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import type { ExecutorSnapshot } from '$shared/executors';
	let { executors: executorSnapshots, ...props }: ComponentProps<typeof SidebarProjectPathDialog> & {
		executors?: readonly ExecutorSnapshot[];
	} = $props();
	const executors = setExecutorsTestContext();
	$effect(() => {
		if (executorSnapshots) executors.applySnapshot(executorSnapshots);
	});
</script>

<SidebarProjectPathDialog {...props} />
