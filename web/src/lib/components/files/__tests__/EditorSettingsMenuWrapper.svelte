<script lang="ts">
	import { setPreferences } from '$lib/context';
	import { createPreferencesStore } from '$lib/stores/preferences.svelte';
	import EditorSettingsMenu from '../EditorSettingsMenu.svelte';

	const store = createPreferencesStore();
	setPreferences(store);
</script>

<EditorSettingsMenu />
