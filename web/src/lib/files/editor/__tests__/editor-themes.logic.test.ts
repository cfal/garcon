import { describe, expect, it } from 'vitest';
import { rendererThemeIdFor } from '$lib/theme/themes.js';
import { editorThemeExtension } from '../editor-themes.js';

describe('editor themes', () => {
	it('deduplicates Classic and Phosphor through renderer presentation metadata', () => {
		expect(rendererThemeIdFor({ colorScheme: 'light', rendererPalette: 'standard' })).toBe(
			'standard-light',
		);
		expect(rendererThemeIdFor({ colorScheme: 'dark', rendererPalette: 'standard' })).toBe(
			'standard-dark',
		);
	});

	it('provides dedicated Colorblind light and dark extensions', () => {
		for (const colorScheme of ['light', 'dark'] as const) {
			const themeId = rendererThemeIdFor({ colorScheme, rendererPalette: 'colorblind' });
			expect(themeId).toBe(`colorblind-${colorScheme}`);
			expect(editorThemeExtension(themeId)).toBeTruthy();
		}
	});

	it('provides dedicated Owl light and dark extensions', () => {
		for (const colorScheme of ['light', 'dark'] as const) {
			const themeId = rendererThemeIdFor({ colorScheme, rendererPalette: 'owl' });
			expect(themeId).toBe(`owl-${colorScheme}`);
			expect(editorThemeExtension(themeId)).toBeTruthy();
		}
	});

	it('provides dedicated Neko light and dark extensions', () => {
		for (const colorScheme of ['light', 'dark'] as const) {
			const themeId = rendererThemeIdFor({ colorScheme, rendererPalette: 'neko' });
			expect(themeId).toBe(`neko-${colorScheme}`);
			expect(editorThemeExtension(themeId)).toBeTruthy();
		}
	});
});
