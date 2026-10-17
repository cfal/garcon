<script lang="ts">
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import PaletteIcon from '@lucide/svelte/icons/palette';
	import { getLocalSettings, getThemeRuntime } from '$lib/context';
	import ThemePreferenceFields from '$lib/components/shared/ThemePreferenceFields.svelte';
	import type { ThemePreference } from '$lib/theme/themes.js';
	import { createThemePreferenceSelection } from '$lib/theme/theme-preference-selection.js';
	import { ONBOARDING_OPTION_CARD_CLASS } from './onboarding-option-card.js';
	import * as m from '$lib/paraglide/messages.js';

	interface OnboardingThemePageProps {
		onSelect: (preference: ThemePreference) => void;
	}

	let { onSelect }: OnboardingThemePageProps = $props();
	const localSettings = getLocalSettings();
	const themeRuntime = getThemeRuntime();
	const selection = createThemePreferenceSelection({
		getPreference: () => localSettings.themePreference,
		getResolvedThemeId: () => themeRuntime.profile.id,
		onSelect: (preference) => onSelect(preference),
	});
</script>

<fieldset class="grid grid-cols-1 gap-3 sm:grid-cols-2">
	<legend class="sr-only">{m.onboarding_theme_title()}</legend>
	<label class={ONBOARDING_OPTION_CARD_CLASS}>
		<input
			type="radio"
			class="sr-only"
			name="onboarding-theme-mode"
			value="system"
			checked={localSettings.themePreference.mode === 'system'}
			onchange={selection.selectSystemMode}
		/>
		<MonitorIcon class="size-6 text-muted-foreground" />
		<span class="text-sm font-medium text-foreground">{m.settings_theme_mode_system()}</span>
		<span class="text-xs text-muted-foreground">{m.onboarding_theme_system_hint()}</span>
	</label>
	<label class={ONBOARDING_OPTION_CARD_CLASS}>
		<input
			type="radio"
			class="sr-only"
			name="onboarding-theme-mode"
			value="fixed"
			checked={localSettings.themePreference.mode === 'fixed'}
			onchange={selection.selectFixedMode}
		/>
		<PaletteIcon class="size-6 text-muted-foreground" />
		<span class="text-sm font-medium text-foreground">{m.settings_theme_mode_fixed()}</span>
		<span class="text-xs text-muted-foreground">{m.onboarding_theme_fixed_hint()}</span>
	</label>
</fieldset>

<div class="mt-4">
	<ThemePreferenceFields preference={localSettings.themePreference} {selection} />
</div>
