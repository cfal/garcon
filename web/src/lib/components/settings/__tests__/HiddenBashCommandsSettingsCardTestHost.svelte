<script lang="ts">
	import HiddenBashCommandsSettingsCard from '../HiddenBashCommandsSettingsCard.svelte';
	import { setLocalSettings } from '$lib/context';
	import { getTestLocalSettingsStore } from './local-settings-test-context';
	import { onDestroy } from 'svelte';

	setLocalSettings(getTestLocalSettingsStore());
	onDestroy(() => getTestLocalSettingsStore().destroy());
</script>

<HiddenBashCommandsSettingsCard />
