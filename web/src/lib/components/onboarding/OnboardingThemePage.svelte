<script lang="ts">
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import PaletteIcon from '@lucide/svelte/icons/palette';
	import { getLocalSettings, getThemeRuntime } from '$lib/context';
	import { THEME_PROFILE_LABELS } from '$lib/components/shared/theme-profile-labels.js';
	import {
		DARK_THEME_PROFILES,
		LIGHT_THEME_PROFILES,
		THEME_PROFILES,
		type ThemePreference,
	} from '$lib/theme/themes.js';
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

{#if localSettings.themePreference.mode === 'fixed'}
	<label class="mt-4 grid gap-1.5 text-sm text-foreground">
		<span>{m.settings_theme_fixed_label()}</span>
		<select
			class="select-native select-native-surface w-full"
			value={localSettings.themePreference.themeId}
			onchange={(event) => selection.selectFixedTheme(event.currentTarget.value)}
		>
			{#each THEME_PROFILES as profile (profile.id)}
				<option value={profile.id}>{THEME_PROFILE_LABELS[profile.id]()}</option>
			{/each}
		</select>
	</label>
{:else}
	<div class="mt-4 grid gap-3 sm:grid-cols-2">
		<label class="grid gap-1.5 text-sm text-foreground">
			<span>{m.settings_theme_system_light_label()}</span>
			<select
				class="select-native select-native-surface w-full"
				value={localSettings.themePreference.lightThemeId}
				onchange={(event) => selection.selectSystemLightTheme(event.currentTarget.value)}
			>
				{#each LIGHT_THEME_PROFILES as profile (profile.id)}
					<option value={profile.id}>{THEME_PROFILE_LABELS[profile.id]()}</option>
				{/each}
			</select>
		</label>
		<label class="grid gap-1.5 text-sm text-foreground">
			<span>{m.settings_theme_system_dark_label()}</span>
			<select
				class="select-native select-native-surface w-full"
				value={localSettings.themePreference.darkThemeId}
				onchange={(event) => selection.selectSystemDarkTheme(event.currentTarget.value)}
			>
				{#each DARK_THEME_PROFILES as profile (profile.id)}
					<option value={profile.id}>{THEME_PROFILE_LABELS[profile.id]()}</option>
				{/each}
			</select>
		</label>
	</div>
{/if}
