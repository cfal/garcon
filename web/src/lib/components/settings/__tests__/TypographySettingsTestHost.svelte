<script lang="ts">
	import { onDestroy } from 'svelte';
	import { setLocalSettings } from '$lib/context';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte';
	import TypographySettings from '../TypographySettings.svelte';
	const settings = createLocalSettingsStore();
	setLocalSettings(settings);
	onDestroy(() => settings.destroy());
</script>

<TypographySettings />
