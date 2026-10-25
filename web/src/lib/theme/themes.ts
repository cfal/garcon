export type ColorScheme = 'light' | 'dark';
export type RendererPalette = 'standard' | 'colorblind' | 'owl' | 'neko' | 'semantic';

export interface TerminalThemeColors {
	readonly background: string;
	readonly foreground: string;
	readonly cursor: string;
	readonly selectionBackground: string;
	readonly selectionForeground: string;
}

export interface ThemeRendererPresentation {
	readonly colorScheme: ColorScheme;
	readonly rendererPalette: RendererPalette;
}

interface ThemeProfileDescriptor {
	readonly id: string;
	readonly colorScheme: ColorScheme;
	readonly browserThemeColor: string;
	readonly rendererPalette: RendererPalette;
}

export const THEME_PROFILES = [
	{
		id: 'classic-light',
		colorScheme: 'light',
		browserThemeColor: '#ffffff',
		rendererPalette: 'standard',
	},
	{
		id: 'classic-dark',
		colorScheme: 'dark',
		browserThemeColor: '#0c1117',
		rendererPalette: 'standard',
	},
	{
		id: 'phosphor-light',
		colorScheme: 'light',
		browserThemeColor: '#f4f6f9',
		rendererPalette: 'standard',
	},
	{
		id: 'phosphor-dark',
		colorScheme: 'dark',
		browserThemeColor: '#090b11',
		rendererPalette: 'standard',
	},
	{
		id: 'colorblind-light',
		colorScheme: 'light',
		browserThemeColor: '#ffffff',
		rendererPalette: 'colorblind',
	},
	{
		id: 'colorblind-dark',
		colorScheme: 'dark',
		browserThemeColor: '#0c1117',
		rendererPalette: 'colorblind',
	},
	{
		id: 'owl-light',
		colorScheme: 'light',
		browserThemeColor: '#fbfbfb',
		rendererPalette: 'owl',
	},
	{
		id: 'owl-dark',
		colorScheme: 'dark',
		browserThemeColor: '#011627',
		rendererPalette: 'owl',
	},
	{
		id: 'neko-light',
		colorScheme: 'light',
		browserThemeColor: '#eff1f5',
		rendererPalette: 'neko',
	},
	{
		id: 'neko-dark',
		colorScheme: 'dark',
		browserThemeColor: '#1e1e2e',
		rendererPalette: 'neko',
	},
	{
		id: 'lagoon-light',
		colorScheme: 'light',
		browserThemeColor: '#f3f9f9',
		rendererPalette: 'semantic',
	},
	{
		id: 'lagoon-dark',
		colorScheme: 'dark',
		browserThemeColor: '#111b1d',
		rendererPalette: 'semantic',
	},
	{
		id: 'rose-light',
		colorScheme: 'light',
		browserThemeColor: '#faf4f6',
		rendererPalette: 'semantic',
	},
	{
		id: 'rose-dark',
		colorScheme: 'dark',
		browserThemeColor: '#1e151a',
		rendererPalette: 'semantic',
	},
	{
		id: 'moss-light',
		colorScheme: 'light',
		browserThemeColor: '#f4f7f2',
		rendererPalette: 'semantic',
	},
	{
		id: 'moss-dark',
		colorScheme: 'dark',
		browserThemeColor: '#141b13',
		rendererPalette: 'semantic',
	},
	{
		id: 'paper-light',
		colorScheme: 'light',
		browserThemeColor: '#f7f1e3',
		rendererPalette: 'semantic',
	},
	{
		id: 'paper-dark',
		colorScheme: 'dark',
		browserThemeColor: '#272420',
		rendererPalette: 'semantic',
	},
	{
		id: 'slate-light',
		colorScheme: 'light',
		browserThemeColor: '#f6f7f9',
		rendererPalette: 'semantic',
	},
	{
		id: 'slate-dark',
		colorScheme: 'dark',
		browserThemeColor: '#282c34',
		rendererPalette: 'semantic',
	},
] as const satisfies readonly ThemeProfileDescriptor[];

export type ThemeProfile = (typeof THEME_PROFILES)[number];
export type ThemeId = ThemeProfile['id'];
export type LightThemeProfile = Extract<ThemeProfile, { colorScheme: 'light' }>;
export type DarkThemeProfile = Extract<ThemeProfile, { colorScheme: 'dark' }>;
export type LightThemeId = LightThemeProfile['id'];
export type DarkThemeId = DarkThemeProfile['id'];
export type RendererThemeId = `${RendererPalette}-${ColorScheme}`;

export type ThemePreference =
	| {
			readonly mode: 'fixed';
			readonly themeId: ThemeId;
	  }
	| {
			readonly mode: 'system';
			readonly lightThemeId: LightThemeId;
			readonly darkThemeId: DarkThemeId;
	  };

export const DEFAULT_THEME_PREFERENCE: ThemePreference = {
	mode: 'system',
	lightThemeId: 'phosphor-light',
	darkThemeId: 'phosphor-dark',
};

export const THEME_FAMILIES = [
	{ id: 'classic', lightThemeId: 'classic-light', darkThemeId: 'classic-dark' },
	{ id: 'phosphor', lightThemeId: 'phosphor-light', darkThemeId: 'phosphor-dark' },
	{ id: 'colorblind', lightThemeId: 'colorblind-light', darkThemeId: 'colorblind-dark' },
	{ id: 'owl', lightThemeId: 'owl-light', darkThemeId: 'owl-dark' },
	{ id: 'neko', lightThemeId: 'neko-light', darkThemeId: 'neko-dark' },
	{ id: 'lagoon', lightThemeId: 'lagoon-light', darkThemeId: 'lagoon-dark' },
	{ id: 'rose', lightThemeId: 'rose-light', darkThemeId: 'rose-dark' },
	{ id: 'moss', lightThemeId: 'moss-light', darkThemeId: 'moss-dark' },
	{ id: 'paper', lightThemeId: 'paper-light', darkThemeId: 'paper-dark' },
	{ id: 'slate', lightThemeId: 'slate-light', darkThemeId: 'slate-dark' },
] as const satisfies readonly {
	readonly id: string;
	readonly lightThemeId: LightThemeId;
	readonly darkThemeId: DarkThemeId;
}[];

export function systemPreferenceForTheme(themeId: ThemeId): ThemePreference {
	const family = THEME_FAMILIES.find(
		(candidate) => candidate.lightThemeId === themeId || candidate.darkThemeId === themeId,
	);
	if (!family) throw new Error(`Missing bundled theme family: ${themeId}`);
	return { mode: 'system', lightThemeId: family.lightThemeId, darkThemeId: family.darkThemeId };
}

export function isThemeId(value: unknown): value is ThemeId {
	return typeof value === 'string' && THEME_PROFILES.some((profile) => profile.id === value);
}

export function getThemeProfile(themeId: ThemeId): ThemeProfile {
	const profile = THEME_PROFILES.find((candidate) => candidate.id === themeId);
	if (!profile) throw new Error(`Missing bundled theme profile: ${themeId}`);
	return profile;
}

export function isLightThemeProfile(profile: ThemeProfile): profile is LightThemeProfile {
	return profile.colorScheme === 'light';
}

export function isDarkThemeProfile(profile: ThemeProfile): profile is DarkThemeProfile {
	return profile.colorScheme === 'dark';
}

export const LIGHT_THEME_PROFILES: readonly LightThemeProfile[] =
	THEME_PROFILES.filter(isLightThemeProfile);
export const DARK_THEME_PROFILES: readonly DarkThemeProfile[] =
	THEME_PROFILES.filter(isDarkThemeProfile);

export function isLightThemeId(value: unknown): value is LightThemeId {
	return typeof value === 'string' && LIGHT_THEME_PROFILES.some((profile) => profile.id === value);
}

export function isDarkThemeId(value: unknown): value is DarkThemeId {
	return typeof value === 'string' && DARK_THEME_PROFILES.some((profile) => profile.id === value);
}

export function parseThemePreference(value: unknown): ThemePreference {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return DEFAULT_THEME_PREFERENCE;
	}

	const candidate = value as Record<string, unknown>;
	if (candidate.mode === 'fixed' && isThemeId(candidate.themeId)) {
		return { mode: 'fixed', themeId: candidate.themeId };
	}
	if (
		candidate.mode === 'system' &&
		isLightThemeId(candidate.lightThemeId) &&
		isDarkThemeId(candidate.darkThemeId)
	) {
		return {
			mode: 'system',
			lightThemeId: candidate.lightThemeId,
			darkThemeId: candidate.darkThemeId,
		};
	}
	return DEFAULT_THEME_PREFERENCE;
}

export function resolveThemeId(
	preference: ThemePreference,
	systemColorScheme: ColorScheme,
): ThemeId {
	if (preference.mode === 'fixed') return preference.themeId;
	return systemColorScheme === 'dark' ? preference.darkThemeId : preference.lightThemeId;
}

export function rendererThemeIdFor(presentation: ThemeRendererPresentation): RendererThemeId {
	return `${presentation.rendererPalette}-${presentation.colorScheme}`;
}
