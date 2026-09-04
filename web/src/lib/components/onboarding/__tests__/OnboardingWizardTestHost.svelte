<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import OnboardingWizard from '../OnboardingWizard.svelte';
	import { setAppShell, setLocalSettings } from '$lib/context';
	import type { AppShellStore } from '$lib/stores/app-shell.svelte';
	import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';

	interface OnboardingWizardTestHostProps {
		appShell: AppShellStore;
		localSettings: LocalSettingsStore;
	}

	let { appShell, localSettings }: OnboardingWizardTestHostProps = $props();

	setAppShell(untrack(() => appShell));
	setLocalSettings(untrack(() => localSettings));

	onDestroy(() => localSettings.destroy());
</script>

{#if appShell.showOnboardingWizard}
	<OnboardingWizard />
{/if}
