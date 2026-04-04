<script lang="ts">
	import { setLocalSettings } from '$lib/context';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte';
	import EditorSettingsMenu from '../EditorSettingsMenu.svelte';

	const store = createLocalSettingsStore();
	setLocalSettings(store);
</script>

<EditorSettingsMenu />
