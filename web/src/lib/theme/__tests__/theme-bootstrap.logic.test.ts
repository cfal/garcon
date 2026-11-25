import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FONT_OPTIONS } from '../fonts.js';
import {
	THEME_PROFILES,
	getThemeProfile,
	parseThemePreference,
	resolveThemeId,
} from '../themes.js';
import {
	TYPOGRAPHY_SIZE_OPTIONS,
	TYPOGRAPHY_SURFACES,
	parseTypographyPreferences,
	typographyFontOverride,
	typographyScale,
} from '../typography.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';

const html = readFileSync(new URL('../../../app.html', import.meta.url), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('Inline theme bootstrap missing');

function bootstrap(stored: Record<string, unknown>, dark = false, stylesheets = {}) {
	const attributes = new Map<string, string>();
	const properties = new Map<string, string>();
	const root = {
		dataset: { theme: '', themeAppearance: '' },
		style: {
			colorScheme: '',
			setProperty: (name: string, value: string) => properties.set(name, value),
		},
		classList: { toggle: (name: string, flag: boolean) => attributes.set(name, String(flag)) },
		setAttribute: (name: string, value: string) => attributes.set(name, value),
	};
	const writes: string[] = [];
	runInNewContext(script!, {
		matchMedia: () => ({ matches: dark }),
		localStorage: {
			getItem: (key: string) =>
				key === LOCAL_STORAGE_KEYS.localSettings ? JSON.stringify(stored) : null,
		},
		document: {
			documentElement: root,
			getElementById: () => ({ textContent: JSON.stringify(stylesheets) }),
			querySelector: () => ({ setAttribute: root.setAttribute }),
			write: (tag: string) => writes.push(tag),
		},
	});
	return { root, attributes, properties, writes };
}

describe('inline theme metadata matches the live theme contracts', () => {
	it.each(THEME_PROFILES)('projects the browser palette for $id', (profile) => {
		const { root, attributes } = bootstrap({
			themePreference: { mode: 'fixed', themeId: profile.id },
		});
		expect(root.dataset.theme).toBe(profile.id);
		expect(root.style.colorScheme).toBe(profile.colorScheme);
		expect(attributes.get('content')).toBe(profile.browserThemeColor);
	});

	it.each([false, true])(
		'uses the canonical fallback for malformed settings (dark: %s)',
		(dark) => {
			const themePreference = {
				mode: 'system',
				lightThemeId: 'classic-dark',
				darkThemeId: 'unknown',
			};
			const fallback = getThemeProfile(
				resolveThemeId(parseThemePreference(themePreference), dark ? 'dark' : 'light'),
			);
			expect(bootstrap({ themePreference }, dark).root.dataset.theme).toBe(fallback.id);
		},
	);

	it.each(FONT_OPTIONS)('keeps surface-specific validation and styles for %s', (font) => {
		for (const size of [...TYPOGRAPHY_SIZE_OPTIONS, 'invalid']) {
			const preferences = Object.fromEntries(
				TYPOGRAPHY_SURFACES.flatMap(({ fontKey, sizeKey }) => [
					[fontKey, font],
					[sizeKey, size],
				]),
			);
			const parsed = parseTypographyPreferences(preferences);
			const { attributes, properties } = bootstrap(preferences);
			for (const { id, fontKey, sizeKey } of TYPOGRAPHY_SURFACES) {
				expect(attributes.get(`data-${id}-font`)).toBe(parsed[fontKey]);
				expect(attributes.get(`data-${id}-font-size`)).toBe(parsed[sizeKey]);
				expect(properties.get(`--${id}-font-override`) ?? '').toBe(
					typographyFontOverride(id, parsed[fontKey]),
				);
				expect(properties.get(`--${id}-font-scale`)).toBe(
					String(typographyScale(id, parsed[sizeKey])),
				);
			}
		}
	});

	it('inserts only the selected stylesheet before the application bootstrap', () => {
		const stylesheets = {
			'rose-dark': '/nested/_app/rose.css',
			'moss-light': '/nested/_app/moss.css',
		};
		const { writes } = bootstrap(
			{ themePreference: { mode: 'fixed', themeId: 'rose-dark' } },
			false,
			stylesheets,
		);
		expect(writes).toEqual([
			'<link rel="stylesheet" data-garcon-theme="rose-dark" href="/nested/_app/rose.css">',
		]);
		expect(bootstrap({}, false, stylesheets).writes).toEqual([]);
	});
});
