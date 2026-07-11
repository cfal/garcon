<script lang="ts">
	import { setAppShell } from '$lib/context';
	import type { AppShellStore } from '$lib/stores/app-shell.svelte';
	import ScheduledPromptsDialog from '../ScheduledPromptsDialog.svelte';

	let { appShell }: { appShell: AppShellStore } = $props();
	setAppShell({
		get showScheduledPrompts() {
			return appShell.showScheduledPrompts;
		},
		closeScheduledPrompts() {
			appShell.closeScheduledPrompts();
		},
	} as never);
</script>

<ScheduledPromptsDialog />
