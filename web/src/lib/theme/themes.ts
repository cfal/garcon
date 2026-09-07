export type ColorScheme = 'light' | 'dark';
export type RendererPalette = 'standard' | 'colorblind';

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
