<script lang="ts">
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import PaletteIcon from '@lucide/svelte/icons/palette';
	import { getLocalSettings, getThemeRuntime } from '$lib/context';
	import { THEME_PROFILE_LABELS } from '$lib/components/shared/theme-profile-labels.js';
	import {
		DEFAULT_THEME_PREFERENCE,
		THEME_PROFILES,
		isDarkThemeId,
		isLightThemeId,
		isThemeId,
		type ThemePreference,
	} from '$lib/theme/themes.js';
	import * as m from '$lib/paraglide/messages.js';

	interface OnboardingThemePageProps {
		onSelect: (preference: ThemePreference) => void;
	}

	let { onSelect }: OnboardingThemePageProps = $props();
	const localSettings = getLocalSettings();
	const theme = getThemeRuntime();
	const lightProfiles = THEME_PROFILES.filter((profile) => profile.colorScheme === 'light');
	const darkProfiles = THEME_PROFILES.filter((profile) => profile.colorScheme === 'dark');
	const optionCardClass =
		'flex cursor-pointer flex-col items-center gap-2 rounded-(--control-radius) border border-border bg-card p-3 text-center transition-colors hover:border-primary/50 has-checked:border-primary has-checked:bg-accent/50 has-checked:shadow-xs has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-1 has-focus-visible:ring-offset-background';

	function selectFixedMode(): void {
		onSelect({ mode: 'fixed', themeId: theme.profile.id });
	}

	function selectSystemMode(): void {
		onSelect(DEFAULT_THEME_PREFERENCE);
	}

	function selectFixedTheme(value: string): void {
		if (isThemeId(value)) onSelect({ mode: 'fixed', themeId: value });
	}

	function selectSystemLightTheme(value: string): void {
		const current = localSettings.themePreference;
		if (current.mode !== 'system' || !isLightThemeId(value)) return;
		onSelect({ ...current, lightThemeId: value });
	}

	function selectSystemDarkTheme(value: string): void {
		const current = localSettings.themePreference;
		if (current.mode !== 'system' || !isDarkThemeId(value)) return;
		onSelect({ ...current, darkThemeId: value });
	}
</script>

<fieldset class="grid grid-cols-1 gap-3 sm:grid-cols-2">
	<legend class="sr-only">{m.onboarding_theme_title()}</legend>
	<label class={optionCardClass}>
		<input
			type="radio"
			class="sr-only"
			name="onboarding-theme-mode"
			value="system"
			checked={localSettings.themePreference.mode === 'system'}
			onchange={selectSystemMode}
		/>
		<MonitorIcon class="size-6 text-muted-foreground" />
		<span class="text-sm font-medium text-foreground">{m.settings_theme_mode_system()}</span>
		<span class="text-xs text-muted-foreground">{m.onboarding_theme_system_hint()}</span>
	</label>
	<label class={optionCardClass}>
		<input
			type="radio"
			class="sr-only"
			name="onboarding-theme-mode"
			value="fixed"
			checked={localSettings.themePreference.mode === 'fixed'}
			onchange={selectFixedMode}
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
			onchange={(event) => selectFixedTheme((event.currentTarget as HTMLSelectElement).value)}
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
				onchange={(event) =>
					selectSystemLightTheme((event.currentTarget as HTMLSelectElement).value)}
			>
				{#each lightProfiles as profile (profile.id)}
					<option value={profile.id}>{THEME_PROFILE_LABELS[profile.id]()}</option>
				{/each}
			</select>
		</label>
		<label class="grid gap-1.5 text-sm text-foreground">
			<span>{m.settings_theme_system_dark_label()}</span>
			<select
				class="select-native select-native-surface w-full"
				value={localSettings.themePreference.darkThemeId}
				onchange={(event) =>
					selectSystemDarkTheme((event.currentTarget as HTMLSelectElement).value)}
			>
				{#each darkProfiles as profile (profile.id)}
					<option value={profile.id}>{THEME_PROFILE_LABELS[profile.id]()}</option>
				{/each}
			</select>
		</label>
	</div>
{/if}
