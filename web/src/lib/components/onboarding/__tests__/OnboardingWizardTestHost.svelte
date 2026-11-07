<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import OnboardingWizard from '../OnboardingWizard.svelte';
	import { setAppShell, setLocalSettings, setRemoteSettings, setThemeRuntime } from '$lib/context';
	import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
	import type { AppShellStore } from '$lib/stores/app-shell.svelte';
	import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import { getThemeProfile, resolveThemeId } from '$lib/theme/themes.js';

	interface OnboardingWizardTestHostProps {
		appShell: AppShellStore;
		localSettings: LocalSettingsStore;
		remoteSettings: RemoteSettingsStore;
	}

	let { appShell, localSettings, remoteSettings }: OnboardingWizardTestHostProps = $props();

	setAppShell(untrack(() => appShell));
	setLocalSettings(untrack(() => localSettings));
	setRemoteSettings(untrack(() => remoteSettings));
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
