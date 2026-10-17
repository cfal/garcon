import * as m from '$lib/paraglide/messages.js';
import type { ThemeId } from '$lib/theme/themes.js';

export const THEME_PROFILE_LABELS: Record<ThemeId, () => string> = {
	'classic-light': m.settings_theme_profile_classic_light,
	'classic-dark': m.settings_theme_profile_classic_dark,
	'phosphor-light': m.settings_theme_profile_phosphor_light,
	'phosphor-dark': m.settings_theme_profile_phosphor_dark,
	'colorblind-light': m.settings_theme_profile_colorblind_light,
	'colorblind-dark': m.settings_theme_profile_colorblind_dark,
	'owl-light': m.settings_theme_profile_owl_light,
	'owl-dark': m.settings_theme_profile_owl_dark,
	'neko-light': m.settings_theme_profile_neko_light,
	'neko-dark': m.settings_theme_profile_neko_dark,
	'lagoon-light': m.settings_theme_profile_lagoon_light,
	'lagoon-dark': m.settings_theme_profile_lagoon_dark,
	'rose-light': m.settings_theme_profile_rose_light,
	'rose-dark': m.settings_theme_profile_rose_dark,
	'moss-light': m.settings_theme_profile_moss_light,
	'moss-dark': m.settings_theme_profile_moss_dark,
	'paper-light': m.settings_theme_profile_paper_light,
	'paper-dark': m.settings_theme_profile_paper_dark,
	'slate-light': m.settings_theme_profile_slate_light,
	'slate-dark': m.settings_theme_profile_slate_dark,
};
