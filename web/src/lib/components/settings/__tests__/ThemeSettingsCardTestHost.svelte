<script lang="ts">
	import { setLocalSettings, setThemeRuntime } from '$lib/context';
	import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import { getThemeProfile, type ThemeId } from '$lib/theme/themes.js';
	import ThemeSettingsCard from '../ThemeSettingsCard.svelte';
	import { untrack } from 'svelte';

	interface ThemeSettingsCardTestHostProps {
		localSettings: LocalSettingsStore;
		resolvedThemeId: ThemeId;
	}

	let { localSettings, resolvedThemeId }: ThemeSettingsCardTestHostProps = $props();
	setLocalSettings(untrack(() => localSettings));
	setThemeRuntime({
		get profile() {
			return getThemeProfile(resolvedThemeId);
		},
	});
</script>

<ThemeSettingsCard />
