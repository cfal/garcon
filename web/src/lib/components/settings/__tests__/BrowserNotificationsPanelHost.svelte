<script lang="ts">
	import { onDestroy } from 'svelte';
	import { setLocalSettings } from '$lib/context';
	import { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import BrowserNotificationsPanel from '../BrowserNotificationsPanel.svelte';
	const settings = setLocalSettings(new LocalSettingsStore());
	onDestroy(() => settings.destroy());
</script>
<BrowserNotificationsPanel />
