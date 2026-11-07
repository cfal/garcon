<script lang="ts">
	import { untrack } from 'svelte';
	import { setAppShell } from '$lib/context';
	import type { AppShellStore } from '$lib/stores/app-shell.svelte';
	import ScheduledPromptsDialog from '../ScheduledPromptsDialog.svelte';

	let { appShell }: { appShell: AppShellStore } = $props();
	setAppShell(untrack(() => appShell));
</script>

<ScheduledPromptsDialog />
