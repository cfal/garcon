import { describe, expect, it, vi } from 'vitest';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import {
	makeRemoteSettingsSnapshot,
	mockRemoteSettingsUpdate,
} from '$lib/stores/__tests__/remote-settings-snapshot-fixture';
import { getRemoteSettings, updateRemoteSettings } from '$lib/api/settings.js';
import { OnboardingTranscriptSearchState } from '../onboarding-transcript-search-state.svelte';

vi.mock('$lib/api/settings.js', () => ({
	getRemoteSettings: vi.fn(),
	updateRemoteSettings: vi.fn(),
}));

function setup(enabled = false) {
	vi.resetAllMocks();
	const settings = new RemoteSettingsStore();
	const snapshot = makeRemoteSettingsSnapshot();
	snapshot.features.transcriptSearch.enabled = enabled;
	settings.applySnapshot(snapshot);
	mockRemoteSettingsUpdate(settings);
	return { settings, search: new OnboardingTranscriptSearchState(settings) };
}

describe('OnboardingTranscriptSearchState', () => {
	it('does not rewrite an already enabled setting', async () => {
		const { search } = setup(true);
		search.activate();
		await vi.waitFor(() => expect(search.isSaving).toBe(false));
		expect(search.enabled).toBe(true);
		expect(updateRemoteSettings).not.toHaveBeenCalled();
	});

	it('enables only once per wizard, retaining an explicit opt-out', async () => {
		const { search } = setup();
		search.activate();
		await vi.waitFor(() => expect(search.isSaving).toBe(false));
		expect(search.enabled).toBe(true);
		await search.setEnabled(false);
		search.deactivate();
		search.activate();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(search.enabled).toBe(false);
		expect(updateRemoteSettings).toHaveBeenCalledTimes(2);
	});

	it('does not enable after leaving during the initial load, but can initialize on return', async () => {
		const { settings, search } = setup();
		settings.snapshot = null;
		const loaded = Promise.withResolvers<ReturnType<typeof makeRemoteSettingsSnapshot>>();
		vi.mocked(getRemoteSettings).mockReturnValueOnce(loaded.promise);
		search.activate();
		expect(search.isSaving).toBe(true);
		search.deactivate();
		loaded.resolve(makeRemoteSettingsSnapshot());
		await vi.waitFor(() => expect(search.isSaving).toBe(false));
		expect(updateRemoteSettings).not.toHaveBeenCalled();
		search.activate();
		await vi.waitFor(() => expect(search.isSaving).toBe(false));
		expect(search.enabled).toBe(true);
	});

	it('allows a failed initial load to be retried', async () => {
		const { settings, search } = setup();
		settings.snapshot = null;
		vi.mocked(getRemoteSettings)
			.mockRejectedValueOnce(new Error('Settings unavailable'))
			.mockResolvedValueOnce(makeRemoteSettingsSnapshot());
		search.activate();
		await vi.waitFor(() => expect(search.isSaving).toBe(false));
		expect(search.error).toBe("Couldn't update transcript search. Please try again.");
		expect(search.enabled).toBe(false);
		search.retry();
		await vi.waitFor(() => expect(search.isSaving).toBe(false));
		expect(search.error).toBeNull();
		expect(search.enabled).toBe(true);
	});

	it('retries the failed opt-out rather than re-enabling search', async () => {
		const { search } = setup(true);
		search.activate();
		await vi.waitFor(() => expect(search.isSaving).toBe(false));
		vi.mocked(updateRemoteSettings).mockRejectedValueOnce(new Error('Save failed'));
		await search.setEnabled(false);
		expect(search.error).toBe("Couldn't update transcript search. Please try again.");
		expect(search.enabled).toBe(true);
		search.retry();
		await vi.waitFor(() => expect(search.isSaving).toBe(false));
		expect(search.enabled).toBe(false);
		expect(search.error).toBeNull();
	});

	it('ignores duplicate changes while saving', async () => {
		const { search } = setup();
		const saved = Promise.withResolvers<Awaited<ReturnType<typeof updateRemoteSettings>>>();
		vi.mocked(updateRemoteSettings).mockReturnValueOnce(saved.promise);
		search.activate();
		await vi.waitFor(() => expect(updateRemoteSettings).toHaveBeenCalledOnce());
		await search.setEnabled(false);
		search.retry();
		expect(updateRemoteSettings).toHaveBeenCalledOnce();
		const snapshot = makeRemoteSettingsSnapshot();
		snapshot.features.transcriptSearch.enabled = true;
		saved.resolve({ success: true, settings: snapshot });
		await vi.waitFor(() => expect(search.isSaving).toBe(false));
		expect(search.enabled).toBe(true);
	});
});
