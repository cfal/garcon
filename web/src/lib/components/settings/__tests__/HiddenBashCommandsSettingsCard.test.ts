import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HiddenBashCommandsSettingsCardTestHost from './HiddenBashCommandsSettingsCardTestHost.svelte';
import { LocalSettingsStore } from '$lib/stores/local-settings.svelte';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import { setTestLocalSettingsStore } from './local-settings-test-context';
import { updateRemoteSettings } from '$lib/api/settings.js';

vi.mock('$lib/api/settings.js', () => ({
	updateRemoteSettings: vi.fn(),
}));

describe('HiddenBashCommandsSettingsCard', () => {
	let localSettings: LocalSettingsStore;

	beforeEach(() => {
		localStorage.clear();
		localSettings = new LocalSettingsStore();
		setTestLocalSettingsStore(localSettings);
	});

	afterEach(() => {
		localSettings.destroy();
	});

	it('adds a pattern through the shared submit path and persists it locally', async () => {
		render(HiddenBashCommandsSettingsCardTestHost);

		await fireEvent.input(screen.getByLabelText('Command pattern'), { target: { value: 'git *' } });
		await fireEvent.submit(screen.getByRole('button', { name: 'Add' }).closest('form')!);

		const persisted = JSON.parse(
			localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}',
		);
		expect(persisted.hiddenBashCommandPatterns).toEqual([{ pattern: 'git *', mode: 'glob' }]);
		expect(screen.getByText('git *')).toBeTruthy();
		expect(updateRemoteSettings).not.toHaveBeenCalled();
	});

	it('adds a regex pattern when regex mode is selected', async () => {
		render(HiddenBashCommandsSettingsCardTestHost);

		await fireEvent.input(screen.getByLabelText('Command pattern'), {
			target: { value: '^cargo' },
		});
		await fireEvent.change(screen.getByLabelText('Pattern type'), {
			target: { value: 'regex' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));

		expect(screen.getByText('^cargo')).toBeTruthy();
		expect(
			within(screen.getByTestId('hidden-bash-command-patterns')).getByText('Regex'),
		).toBeTruthy();
	});

	it('adds a preset once while preserving manual patterns', async () => {
		localSettings.addHiddenBashCommandPattern({ pattern: 'manual *', mode: 'glob' });
		localSettings.addHiddenBashCommandPattern({
			pattern: '^\\./(?:oracle|finder|librarian|reporter)(?:\\s|$)',
			mode: 'regex',
		});
		render(HiddenBashCommandsSettingsCardTestHost);

		await fireEvent.click(screen.getByRole('button', { name: 'Add preset' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: 'Garcon-amp rules' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Add preset' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: 'Garcon-amp rules' }));

		expect(localSettings.hiddenBashCommandPatterns).toEqual([
			{ pattern: 'manual *', mode: 'glob' },
			{
				pattern: '^\\./(?:oracle|finder|librarian|reporter)(?:\\s|$)',
				mode: 'regex',
			},
			{
				pattern:
					'^/tmp/garcon-amp-[0-9]+/(?:oracle|finder|librarian|reporter)(?:\\s|$)',
				mode: 'regex',
			},
		]);
		expect(updateRemoteSettings).not.toHaveBeenCalled();
	});

	it('rejects empty, invalid regex, and duplicate patterns with inline errors', async () => {
		render(HiddenBashCommandsSettingsCardTestHost);
		const input = screen.getByLabelText('Command pattern');

		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		expect(screen.getByRole('alert').textContent).toBe('Enter a pattern');

		await fireEvent.input(input, { target: { value: '([unclosed' } });
		await fireEvent.change(screen.getByLabelText('Pattern type'), { target: { value: 'regex' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		expect(screen.getByRole('alert').textContent).toBe('Invalid regular expression');

		await fireEvent.input(input, { target: { value: 'git *' } });
		await fireEvent.change(screen.getByLabelText('Pattern type'), { target: { value: 'glob' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		expect(screen.queryByRole('alert')).toBeNull();

		await fireEvent.input(input, { target: { value: 'git *' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		expect(screen.getByRole('alert').textContent).toBe('This pattern is already hidden');
	});

	it('removes an existing pattern', async () => {
		localSettings.addHiddenBashCommandPattern({ pattern: 'git *', mode: 'glob' });
		render(HiddenBashCommandsSettingsCardTestHost);

		await fireEvent.click(
			screen.getByRole('button', { name: 'Remove pattern: git * (Glob)' }),
		);

		await waitFor(() => {
			expect(
				JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}')
					.hiddenBashCommandPatterns,
			).toEqual([]);
		});
		expect(screen.queryByText('git *')).toBeNull();
	});

	it('keeps dialog controls at touch-friendly font sizes', () => {
		render(HiddenBashCommandsSettingsCardTestHost);

		const input = screen.getByLabelText('Command pattern');
		expect(input.className).toContain('text-base');
		const modeSelect = screen.getByLabelText('Pattern type');
		expect(modeSelect.className).toContain('text-base');
	});

	it('restores patterns persisted by an earlier session', () => {
		localSettings.addHiddenBashCommandPattern({ pattern: 'cargo *', mode: 'glob' });
		const later = new LocalSettingsStore();

		try {
			expect(later.hiddenBashCommandPatterns).toEqual([{ pattern: 'cargo *', mode: 'glob' }]);
		} finally {
			later.destroy();
		}
	});
});
