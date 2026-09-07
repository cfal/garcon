<script lang="ts">
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

	const localSettings = getLocalSettings();
	const theme = getThemeRuntime();
	const lightProfiles = THEME_PROFILES.filter((profile) => profile.colorScheme === 'light');
	const darkProfiles = THEME_PROFILES.filter((profile) => profile.colorScheme === 'dark');

	function setPreference(preference: ThemePreference): void {
		localSettings.set('themePreference', preference);
	}

	function selectFixedMode(): void {
		setPreference({ mode: 'fixed', themeId: theme.profile.id });
	}

	function selectSystemMode(): void {
		setPreference(DEFAULT_THEME_PREFERENCE);
	}

	function selectFixedTheme(value: string): void {
		if (isThemeId(value)) setPreference({ mode: 'fixed', themeId: value });
	}

	function selectSystemLightTheme(value: string): void {
		const current = localSettings.themePreference;
		if (current.mode !== 'system' || !isLightThemeId(value)) return;
		setPreference({ ...current, lightThemeId: value });
	}

	function selectSystemDarkTheme(value: string): void {
		const current = localSettings.themePreference;
		if (current.mode !== 'system' || !isDarkThemeId(value)) return;
		setPreference({ ...current, darkThemeId: value });
	}
</script>

<div class="px-4 py-3">
	<fieldset>
		<legend class="text-sm font-medium text-foreground">{m.settings_theme_title()}</legend>
		<div class="mt-2 flex flex-wrap gap-x-5 gap-y-2">
			<label class="flex cursor-pointer items-center gap-2 text-sm text-foreground">
				<input
					type="radio"
					name="settings-theme-mode"
					value="system"
					checked={localSettings.themePreference.mode === 'system'}
					onchange={selectSystemMode}
				/>
				{m.settings_theme_mode_system()}
			</label>
			<label class="flex cursor-pointer items-center gap-2 text-sm text-foreground">
				<input
					type="radio"
					name="settings-theme-mode"
					value="fixed"
					checked={localSettings.themePreference.mode === 'fixed'}
					onchange={selectFixedMode}
				/>
				{m.settings_theme_mode_fixed()}
			</label>
		</div>
	</fieldset>

	{#if localSettings.themePreference.mode === 'fixed'}
		<label class="mt-3 flex items-center justify-between gap-4 text-sm text-foreground">
			<span>{m.settings_theme_fixed_label()}</span>
			<select
				class="select-native w-48 max-w-[60%] shrink-0"
				value={localSettings.themePreference.themeId}
				onchange={(event) => selectFixedTheme((event.currentTarget as HTMLSelectElement).value)}
			>
				{#each THEME_PROFILES as profile (profile.id)}
					<option value={profile.id}>{THEME_PROFILE_LABELS[profile.id]()}</option>
				{/each}
			</select>
		</label>
	{:else}
		<div class="mt-3 grid gap-3 sm:grid-cols-2">
			<label class="grid gap-1.5 text-sm text-foreground">
				<span>{m.settings_theme_system_light_label()}</span>
				<select
					class="select-native w-full"
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
					class="select-native w-full"
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
</div>
