<script lang="ts">
	import { setAppShell } from '$lib/context';
	import type { AppShellStore } from '$lib/stores/app-shell.svelte';
	import ScheduledTasksDialog from '../ScheduledTasksDialog.svelte';

	let { appShell }: { appShell: AppShellStore } = $props();
	setAppShell({
		get showScheduledTasks() {
			return appShell.showScheduledTasks;
		},
		closeScheduledTasks() {
			appShell.closeScheduledTasks();
		},
	} as never);
</script>

<ScheduledTasksDialog />
