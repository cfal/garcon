<script lang="ts">
	import HiddenBashCommandsSettingsCard from '../HiddenBashCommandsSettingsCard.svelte';
	import { setRemoteSettings } from '$lib/context';
	import { getTestRemoteSettingsStore } from './remote-settings-test-context';

	setRemoteSettings(getTestRemoteSettingsStore());
</script>

<HiddenBashCommandsSettingsCard />
