import { describe, expect, it } from 'vitest';
import { editorThemeExtension, resolveEditorThemeId } from '../editor-themes.js';

describe('editor themes', () => {
	it('deduplicates Classic and Phosphor through renderer presentation metadata', () => {
		expect(resolveEditorThemeId({ colorScheme: 'light', rendererPalette: 'standard' })).toBe(
			'standard-light',
		);
		expect(resolveEditorThemeId({ colorScheme: 'dark', rendererPalette: 'standard' })).toBe(
			'standard-dark',
		);
	});

	it('provides dedicated Colorblind light and dark extensions', () => {
		for (const colorScheme of ['light', 'dark'] as const) {
			const themeId = resolveEditorThemeId({ colorScheme, rendererPalette: 'colorblind' });
			expect(themeId).toBe(`colorblind-${colorScheme}`);
			expect(editorThemeExtension(themeId)).toBeTruthy();
		}
	});
});
