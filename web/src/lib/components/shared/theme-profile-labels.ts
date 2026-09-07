import * as m from '$lib/paraglide/messages.js';
import type { ThemeId } from '$lib/theme/themes.js';

export const THEME_PROFILE_LABELS: Record<ThemeId, () => string> = {
	'classic-light': m.settings_theme_profile_classic_light,
	'classic-dark': m.settings_theme_profile_classic_dark,
	'phosphor-light': m.settings_theme_profile_phosphor_light,
	'phosphor-dark': m.settings_theme_profile_phosphor_dark,
	'colorblind-light': m.settings_theme_profile_colorblind_light,
	'colorblind-dark': m.settings_theme_profile_colorblind_dark,
};
