<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import OnboardingWizard from '../OnboardingWizard.svelte';
	import { setAppShell, setLocalSettings, setThemeRuntime } from '$lib/context';
	import type { AppShellStore } from '$lib/stores/app-shell.svelte';
	import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import { getThemeProfile, resolveThemeId } from '$lib/theme/themes.js';

	interface OnboardingWizardTestHostProps {
		appShell: AppShellStore;
		localSettings: LocalSettingsStore;
	}

	let { appShell, localSettings }: OnboardingWizardTestHostProps = $props();

	setAppShell(untrack(() => appShell));
	setLocalSettings(untrack(() => localSettings));
	setThemeRuntime({
		get profile() {
			return getThemeProfile(resolveThemeId(localSettings.themePreference, 'light'));
		},
	});

	onDestroy(() => localSettings.destroy());
</script>

{#if appShell.showOnboardingWizard}
	<OnboardingWizard />
{/if}
