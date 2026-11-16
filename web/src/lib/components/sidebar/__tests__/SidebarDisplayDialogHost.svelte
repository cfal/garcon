<script lang="ts">
	import { untrack } from 'svelte';
	import { setLocalSettings, setRemoteSettings } from '$lib/context';
	import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte';
	import { createRemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
	import SidebarDisplayDialog from '../SidebarDisplayDialog.svelte';
	let { settings }: { settings: LocalSettingsStore } = $props();
	let open = $state(true);
	setLocalSettings(untrack(() => settings));
	setRemoteSettings(createRemoteSettingsStore());
</script>

{#if open}<SidebarDisplayDialog onClose={() => (open = false)} />{/if}
