import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
import ThemeSettingsCardTestHost from './ThemeSettingsCardTestHost.svelte';

describe('ThemeSettingsCard', () => {
	beforeEach(() => localStorage.clear());

	afterEach(() => cleanup());

	it('filters System choices by declared profile scheme', () => {
		const localSettings = createLocalSettingsStore();
		render(ThemeSettingsCardTestHost, {
			localSettings,
			resolvedThemeId: 'phosphor-light',
		});

		const lightSelect = screen.getByRole('combobox', { name: 'Light theme' });
		const darkSelect = screen.getByRole('combobox', { name: 'Dark theme' });
		expect([...lightSelect.querySelectorAll('option')].map((option) => option.textContent)).toEqual(
			[
				'Classic Light',
				'Phosphor Light',
				'Colorblind Light',
				'Owl Daybreak',
				'Neko Frost',
				'Lagoon Light',
				'Rose Light',
				'Moss Light',
			],
		);
		expect([...darkSelect.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
			'Classic Dark',
			'Phosphor Dark',
			'Colorblind Dark',
			'Owl Nightfall',
			'Neko Velvet',
			'Lagoon Dark',
			'Rose Dark',
			'Moss Dark',
		]);
		localSettings.destroy();
	});

	it('enters Fixed mode with the currently resolved profile', async () => {
		const localSettings = createLocalSettingsStore();
		render(ThemeSettingsCardTestHost, {
			localSettings,
			resolvedThemeId: 'phosphor-dark',
		});

		await fireEvent.click(screen.getByRole('radio', { name: 'Use one theme' }));
		expect(localSettings.themePreference).toEqual({
			mode: 'fixed',
			themeId: 'phosphor-dark',
		});
		localSettings.destroy();
	});

	it('updates a concrete profile and follows its family in System mode', async () => {
		const localSettings = createLocalSettingsStore();
		localSettings.set('themePreference', { mode: 'fixed', themeId: 'classic-light' });
		render(ThemeSettingsCardTestHost, {
			localSettings,
			resolvedThemeId: 'classic-light',
		});

		await fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), {
			target: { value: 'colorblind-dark' },
		});
		expect(localSettings.themePreference).toEqual({
			mode: 'fixed',
			themeId: 'colorblind-dark',
		});

		await fireEvent.click(screen.getByRole('radio', { name: 'Follow system' }));
		expect(localSettings.themePreference).toEqual({
			mode: 'system',
			lightThemeId: 'colorblind-light',
			darkThemeId: 'colorblind-dark',
		});
		localSettings.destroy();
	});
});
