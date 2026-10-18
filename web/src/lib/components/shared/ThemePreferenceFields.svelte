<script lang="ts">
	import {
		DARK_THEME_PROFILES,
		LIGHT_THEME_PROFILES,
		THEME_PROFILES,
		type ThemeId,
		type ThemePreference,
		type ThemeProfile,
	} from '$lib/theme/themes.js';
	import type { ThemePreferenceSelection } from '$lib/theme/theme-preference-selection.js';
	import { THEME_PROFILE_LABELS } from './theme-profile-labels.js';
	import ThemePalettePreview from './ThemePalettePreview.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let {
		preference,
		selection,
	}: { preference: ThemePreference; selection: ThemePreferenceSelection } = $props();
</script>

{#snippet themeSelect(
	label: string,
	themeId: ThemeId,
	profiles: readonly ThemeProfile[],
	onSelect: (id: string) => void,
)}
	<label class="grid min-w-0 gap-1.5 text-sm text-foreground">
		<span class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
			<span>{label}</span>
			<ThemePalettePreview {themeId} />
		</span>
		<select
			class="select-native w-full"
			value={themeId}
			onchange={(event) => onSelect(event.currentTarget.value)}
		>
			{#each profiles as profile (profile.id)}
				<option value={profile.id}>{THEME_PROFILE_LABELS[profile.id]()}</option>
			{/each}
		</select>
	</label>
{/snippet}

{#if preference.mode === 'fixed'}
	{@render themeSelect(
		m.settings_theme_fixed_label(),
		preference.themeId,
		THEME_PROFILES,
		selection.selectFixedTheme,
	)}
{:else}
	<div class="grid gap-3 sm:grid-cols-2">
		{@render themeSelect(
			m.settings_theme_system_light_label(),
			preference.lightThemeId,
			LIGHT_THEME_PROFILES,
			selection.selectSystemLightTheme,
		)}
		{@render themeSelect(
			m.settings_theme_system_dark_label(),
			preference.darkThemeId,
			DARK_THEME_PROFILES,
			selection.selectSystemDarkTheme,
		)}
	</div>
{/if}
