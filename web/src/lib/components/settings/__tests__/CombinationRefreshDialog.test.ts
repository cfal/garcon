import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
	createLocalSettingsStore,
	type LocalSettingsStore,
} from '$lib/stores/local-settings.svelte.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence.js';
import CombinationRefreshDialog from '../CombinationRefreshDialog.svelte';

let settings: LocalSettingsStore;
vi.mock('$lib/context', () => ({
	getLocalSettings: () => settings,
	getOptionalTransientLayers: () => null,
}));

beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	settings.destroy();
	vi.restoreAllMocks();
});

it.each([true, false])(
	'saves the preference, allows dismissal, and refreshes only on request (active %s)',
	async (combined) => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({ combineToolUseMessages: combined }),
		);
		settings = createLocalSettingsStore();
		const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
		render(CombinationRefreshDialog);
		expect(screen.queryByRole('dialog')).toBeNull();

		settings.toggle('combineToolUseMessages');
		await screen.findByRole('dialog', { name: 'Refresh required' });
		expect(settings.activeCombineToolUseMessages).toBe(combined);
		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings)!).combineToolUseMessages,
		).toBe(!combined);
		await fireEvent.click(screen.getByRole('button', { name: 'Later' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		settings.toggle('showThinking');
		await Promise.resolve();
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(reload).not.toHaveBeenCalled();

		settings.toggle('combineToolUseMessages');
		await Promise.resolve();
		expect(screen.queryByRole('dialog')).toBeNull();
		settings.toggle('combineToolUseMessages');
		await screen.findByRole('dialog', { name: 'Refresh required' });
		await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(reload).toHaveBeenCalledOnce();
		expect(settings.activeCombineToolUseMessages).toBe(combined);
		const refreshed = createLocalSettingsStore();
		expect(refreshed.activeCombineToolUseMessages).toBe(!combined);
		refreshed.destroy();
	},
);

it('prompts for other-tab changes and permits Escape without applying them', async () => {
	settings = createLocalSettingsStore();
	render(CombinationRefreshDialog);
	const newValue = JSON.stringify({ ...settings.snapshot(), combineToolUseMessages: false });
	localStorage.setItem(LOCAL_STORAGE_KEYS.localSettings, newValue);
	window.dispatchEvent(
		new StorageEvent('storage', {
			key: LOCAL_STORAGE_KEYS.localSettings,
			newValue,
			storageArea: localStorage,
		}),
	);
	const dialog = await screen.findByRole('dialog', { name: 'Refresh required' });
	await fireEvent.keyDown(dialog, { key: 'Escape' });
	await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	expect(settings.combineToolUseMessages).toBe(false);
	expect(settings.activeCombineToolUseMessages).toBe(true);
});
