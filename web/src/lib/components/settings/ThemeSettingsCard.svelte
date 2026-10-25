<script lang="ts">
	import { getLocalSettings, getThemeRuntime } from '$lib/context';
	import ThemePreferenceFields from '$lib/components/shared/ThemePreferenceFields.svelte';
	import type { ThemePreference } from '$lib/theme/themes.js';
	import { createThemePreferenceSelection } from '$lib/theme/theme-preference-selection.js';
	import * as m from '$lib/paraglide/messages.js';

	const localSettings = getLocalSettings();
	const themeRuntime = getThemeRuntime();

	function setPreference(preference: ThemePreference): void {
		localSettings.set('themePreference', preference);
	}

	const selection = createThemePreferenceSelection({
		getPreference: () => localSettings.themePreference,
		getResolvedThemeId: () => themeRuntime.profile.id,
		onSelect: setPreference,
	});
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
					onchange={selection.selectSystemMode}
				/>
				{m.settings_theme_mode_system()}
			</label>
			<label class="flex cursor-pointer items-center gap-2 text-sm text-foreground">
				<input
					type="radio"
					name="settings-theme-mode"
					value="fixed"
					checked={localSettings.themePreference.mode === 'fixed'}
					onchange={selection.selectFixedMode}
				/>
				{m.settings_theme_mode_fixed()}
			</label>
		</div>
	</fieldset>

	<div class="mt-3">
		<ThemePreferenceFields preference={localSettings.themePreference} {selection} />
	</div>
</div>
