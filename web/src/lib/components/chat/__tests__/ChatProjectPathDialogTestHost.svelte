<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import ChatProjectPathDialog from '$lib/components/chat/ChatProjectPathDialog.svelte';
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import type { ExecutorSnapshot } from '$shared/executors';
	let { executors: executorSnapshots, ...props }: ComponentProps<typeof ChatProjectPathDialog> & {
		executors?: readonly ExecutorSnapshot[];
	} = $props();
	const executors = setExecutorsTestContext();
	$effect(() => {
		if (executorSnapshots) executors.applySnapshot(executorSnapshots);
	});
</script>

<ChatProjectPathDialog {...props} />
