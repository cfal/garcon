<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import ChatProjectPathDialog from '$lib/components/chat/ChatProjectPathDialog.svelte';
	import { setNotifications } from '$lib/context';
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import type { ExecutorSnapshot } from '$shared/executors';
	let { executors: executorSnapshots, ...props }: ComponentProps<typeof ChatProjectPathDialog> & {
		executors?: readonly ExecutorSnapshot[];
	} = $props();
	const executors = setExecutorsTestContext();
	setNotifications(createNotificationsStore());
	$effect(() => {
		if (executorSnapshots) executors.applySnapshot(executorSnapshots);
	});
</script>

<ChatProjectPathDialog {...props} />
