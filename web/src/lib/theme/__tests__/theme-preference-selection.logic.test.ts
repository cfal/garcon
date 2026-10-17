import { describe, expect, it, vi } from 'vitest';
import { createThemePreferenceSelection } from '../theme-preference-selection.js';
import { THEME_FAMILIES, type ThemePreference } from '../themes.js';

describe('theme preference selection', () => {
	it('pairs both fixed schemes without depending on a delayed DOM projection', () => {
		for (const family of THEME_FAMILIES) {
			for (const themeId of [family.lightThemeId, family.darkThemeId]) {
				const onSelect = vi.fn();
				createThemePreferenceSelection({
					getPreference: () => ({ mode: 'fixed', themeId }),
					getResolvedThemeId: () => 'phosphor-light',
					onSelect,
				}).selectSystemMode();
				expect(onSelect).toHaveBeenCalledWith({
					mode: 'system',
					lightThemeId: family.lightThemeId,
					darkThemeId: family.darkThemeId,
				});
			}
		}
	});

	it('preserves mixed System choices and changes each slot independently', () => {
		let preference: ThemePreference = {
			mode: 'system',
			lightThemeId: 'rose-light',
			darkThemeId: 'moss-dark',
		};
		const onSelect = vi.fn((next: ThemePreference) => {
			preference = next;
		});
		const selection = createThemePreferenceSelection({
			getPreference: () => preference,
			getResolvedThemeId: () => 'rose-light',
			onSelect,
		});
		selection.selectSystemMode();
		expect(onSelect).not.toHaveBeenCalled();
		selection.selectSystemLightTheme('lagoon-light');
		expect(preference).toEqual({
			mode: 'system',
			lightThemeId: 'lagoon-light',
			darkThemeId: 'moss-dark',
		});
		selection.selectSystemDarkTheme('rose-dark');
		expect(preference).toEqual({
			mode: 'system',
			lightThemeId: 'lagoon-light',
			darkThemeId: 'rose-dark',
		});
		selection.selectSystemLightTheme('moss-dark');
		selection.selectSystemDarkTheme('invalid');
		expect(onSelect).toHaveBeenCalledTimes(2);
	});
});
