<script lang="ts">
	import { untrack, type ComponentProps } from 'svelte';
	import GitTargetDialog from '../GitTargetDialog.svelte';
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context.js';
	import type { ExecutorSnapshot } from '$shared/executors';
	import type { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
	import { setNotifications } from '$lib/context';
	import { NotificationsStore } from '$lib/stores/notifications.svelte.js';
	let {
		executors,
		onExecutors,
		notifications = new NotificationsStore(),
		...props
	}: ComponentProps<typeof GitTargetDialog> & {
		executors?: readonly ExecutorSnapshot[];
		onExecutors?: (store: ExecutorsStore) => void;
		notifications?: NotificationsStore;
	} = $props();
	untrack(() => {
		const store = setExecutorsTestContext(executors);
		setNotifications(notifications);
		onExecutors?.(store);
	});
</script>

<GitTargetDialog {...props} />
