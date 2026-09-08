import {
	DEFAULT_THEME_PREFERENCE,
	isDarkThemeId,
	isLightThemeId,
	isThemeId,
	type ThemeId,
	type ThemePreference,
} from './themes.js';

interface ThemePreferenceSelectionOptions {
	readonly getPreference: () => ThemePreference;
	readonly getResolvedThemeId: () => ThemeId;
	readonly onSelect: (preference: ThemePreference) => void;
}

export interface ThemePreferenceSelection {
	readonly selectFixedMode: () => void;
	readonly selectSystemMode: () => void;
	readonly selectFixedTheme: (themeId: string) => void;
	readonly selectSystemLightTheme: (themeId: string) => void;
	readonly selectSystemDarkTheme: (themeId: string) => void;
}

export function createThemePreferenceSelection(
	options: ThemePreferenceSelectionOptions,
): ThemePreferenceSelection {
	return {
		selectFixedMode() {
			options.onSelect({ mode: 'fixed', themeId: options.getResolvedThemeId() });
		},
		selectSystemMode() {
			options.onSelect(DEFAULT_THEME_PREFERENCE);
		},
		selectFixedTheme(themeId) {
			if (isThemeId(themeId)) options.onSelect({ mode: 'fixed', themeId });
		},
		selectSystemLightTheme(themeId) {
			const preference = options.getPreference();
			if (preference.mode !== 'system' || !isLightThemeId(themeId)) return;
			options.onSelect({ ...preference, lightThemeId: themeId });
		},
		selectSystemDarkTheme(themeId) {
			const preference = options.getPreference();
			if (preference.mode !== 'system' || !isDarkThemeId(themeId)) return;
			options.onSelect({ ...preference, darkThemeId: themeId });
		},
	};
}
