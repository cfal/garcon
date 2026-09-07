import { describe, expect, it } from 'vitest';
import {
	DEFAULT_THEME_PREFERENCE,
	THEME_PROFILES,
	getThemeProfile,
	isDarkThemeId,
	isLightThemeId,
	parseThemePreference,
	rendererThemeIdFor,
	resolveThemeId,
} from '../themes.js';

describe('theme profiles', () => {
	it('keeps registered IDs unique', () => {
		const ids = THEME_PROFILES.map((profile) => profile.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('resolves every registered profile', () => {
		for (const profile of THEME_PROFILES) {
			expect(getThemeProfile(profile.id)).toBe(profile);
		}
	});

	it('classifies profile IDs by their declared scheme', () => {
		expect(THEME_PROFILES.filter(({ id }) => isLightThemeId(id)).map(({ id }) => id)).toEqual([
			'classic-light',
			'phosphor-light',
			'colorblind-light',
		]);
		expect(THEME_PROFILES.filter(({ id }) => isDarkThemeId(id)).map(({ id }) => id)).toEqual([
			'classic-dark',
			'phosphor-dark',
			'colorblind-dark',
		]);
	});

	it('resolves the default Phosphor pair through the system scheme', () => {
		expect(resolveThemeId(DEFAULT_THEME_PREFERENCE, 'light')).toBe('phosphor-light');
		expect(resolveThemeId(DEFAULT_THEME_PREFERENCE, 'dark')).toBe('phosphor-dark');
	});

	it('resolves fixed preferences independently of the system scheme', () => {
		const preference = parseThemePreference({ mode: 'fixed', themeId: 'colorblind-dark' });
		expect(resolveThemeId(preference, 'light')).toBe('colorblind-dark');
		expect(resolveThemeId(preference, 'dark')).toBe('colorblind-dark');
	});

	it('accepts valid configurable system pairs', () => {
		expect(
			parseThemePreference({
				mode: 'system',
				lightThemeId: 'classic-light',
				darkThemeId: 'colorblind-dark',
			}),
		).toEqual({
			mode: 'system',
			lightThemeId: 'classic-light',
			darkThemeId: 'colorblind-dark',
		});
	});

	it.each([
		undefined,
		null,
		'phosphor-dark',
		[],
		{ mode: 'fixed' },
		{ mode: 'fixed', themeId: 'unknown' },
		{ mode: 'fixed', themeId: ['classic-dark'] },
		{ mode: 'fixed', themeId: 'toString' },
		{ mode: 'fixed', themeId: '__proto__' },
		{ mode: 'system', lightThemeId: 'classic-dark', darkThemeId: 'phosphor-dark' },
		{ mode: 'system', lightThemeId: 'classic-light', darkThemeId: 'phosphor-light' },
		{ mode: 'system', lightThemeId: 'classic-light' },
	])('falls back atomically for invalid preference %j', (value) => {
		expect(parseThemePreference(value)).toEqual(DEFAULT_THEME_PREFERENCE);
	});

	it('derives renderer theme IDs without using profile naming conventions', () => {
		expect(rendererThemeIdFor({ colorScheme: 'light', rendererPalette: 'standard' })).toBe(
			'standard-light',
		);
		expect(rendererThemeIdFor({ colorScheme: 'dark', rendererPalette: 'colorblind' })).toBe(
			'colorblind-dark',
		);
	});
});
