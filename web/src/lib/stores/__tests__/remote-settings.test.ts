import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteSettingsStore } from '../remote-settings.svelte';
import { makeRemoteSettingsSnapshot } from './remote-settings-snapshot-fixture';

vi.mock('$lib/api/settings.js', () => ({
	getRemoteSettings: vi.fn(),
	updateRemoteSettings: vi.fn(),
}));

const settingsApi = await import('$lib/api/settings.js');
const mockedSettingsApi = vi.mocked(settingsApi);

describe('RemoteSettingsStore', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('loads the initial snapshot through ensureLoaded', async () => {
		mockedSettingsApi.getRemoteSettings.mockResolvedValue(
			makeRemoteSettingsSnapshot({ version: 3 }),
		);
		const store = new RemoteSettingsStore();

		const snapshot = await store.ensureLoaded();

		expect(snapshot.version).toBe(3);
		expect(store.snapshot?.version).toBe(3);
		expect(store.status).toBe('ready');
		expect(store.error).toBeNull();
	});

	it('swallows background preload failures after storing the error state', async () => {
		mockedSettingsApi.getRemoteSettings.mockRejectedValue(new Error('network down'));
		const store = new RemoteSettingsStore();

		await expect(store.ensureLoadedInBackground()).resolves.toBeUndefined();

		expect(store.snapshot).toBeNull();
		expect(store.status).toBe('error');
		expect(store.error).toBe('network down');
	});

	it.each(['resolve', 'reject'] as const)('starts a latest read after an older pending read %ss', async (settlement) => {
		const oldRead = Promise.withResolvers<ReturnType<typeof makeRemoteSettingsSnapshot>>();
		const fresh = makeRemoteSettingsSnapshot({ version: 3 });
		mockedSettingsApi.getRemoteSettings.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(fresh);
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeRemoteSettingsSnapshot({ version: 1 }));
		const previous = store.refresh();
		const previousSettled = Promise.allSettled([previous]);
		const latest = store.refreshLatest();
		expect(mockedSettingsApi.getRemoteSettings).toHaveBeenCalledTimes(1);
		if (settlement === 'resolve') oldRead.resolve(makeRemoteSettingsSnapshot({ version: 2 }));
		else oldRead.reject(new Error('older read failed'));

		expect(await latest).toEqual(fresh);
		await previousSettled;
		expect(mockedSettingsApi.getRemoteSettings).toHaveBeenCalledTimes(2);
		expect(store.error).toBeNull();
		store.applySnapshot(makeRemoteSettingsSnapshot({ version: 2 }));
		expect(store.snapshot).toEqual(fresh);
	});

	it('ignores stale refresh responses after a newer snapshot is already applied', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeRemoteSettingsSnapshot({ version: 5, ui: { pinnedInsertPosition: 'top' } }),
		);
		mockedSettingsApi.getRemoteSettings.mockResolvedValue(
			makeRemoteSettingsSnapshot({ version: 4, ui: { pinnedInsertPosition: 'bottom' } }),
		);

		const snapshot = await store.refresh();

		expect(snapshot.version).toBe(5);
		expect(store.snapshot?.version).toBe(5);
		expect(store.snapshot?.ui.pinnedInsertPosition).toBe('top');
	});

	it('swallows background refresh failures while preserving the cached snapshot', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeRemoteSettingsSnapshot({ version: 5, ui: { pinnedInsertPosition: 'top' } }),
		);
		mockedSettingsApi.getRemoteSettings.mockRejectedValue(new Error('refresh failed'));

		await expect(store.refreshInBackground()).resolves.toBeUndefined();

		expect(store.snapshot?.version).toBe(5);
		expect(store.snapshot?.ui.pinnedInsertPosition).toBe('top');
		expect(store.status).toBe('ready');
		expect(store.error).toBe('refresh failed');
	});

	it('applies newer update responses', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeRemoteSettingsSnapshot({ version: 1 }));
		mockedSettingsApi.updateRemoteSettings.mockResolvedValue({
			success: true,
			settings: makeRemoteSettingsSnapshot({
				version: 2,
				ui: { pinnedInsertPosition: 'bottom' },
			}),
		});

		const snapshot = await store.update({ ui: { pinnedInsertPosition: 'bottom' } });

		expect(snapshot.version).toBe(2);
		expect(store.snapshot?.version).toBe(2);
		expect(store.snapshot?.ui.pinnedInsertPosition).toBe('bottom');
	});

	it('ignores stale update responses after a newer snapshot arrives', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeRemoteSettingsSnapshot({ version: 4, ui: { pinnedInsertPosition: 'top' } }),
		);
		mockedSettingsApi.updateRemoteSettings.mockResolvedValue({
			success: true,
			settings: makeRemoteSettingsSnapshot({
				version: 3,
				ui: { pinnedInsertPosition: 'bottom' },
			}),
		});

		const snapshot = await store.update({ ui: { pinnedInsertPosition: 'bottom' } });

		expect(snapshot.version).toBe(4);
		expect(store.snapshot?.version).toBe(4);
		expect(store.snapshot?.ui.pinnedInsertPosition).toBe('top');
	});

	it('rolls back an optimistic snapshot when it is still current', () => {
		const store = new RemoteSettingsStore();
		const previous = makeRemoteSettingsSnapshot({
			version: 1,
			ui: { pinnedInsertPosition: 'top' },
		});
		const optimistic = makeRemoteSettingsSnapshot({
			version: 1,
			ui: { pinnedInsertPosition: 'bottom' },
		});
		store.applySnapshot(previous);

		const rollback = store.applyOptimisticSnapshot(optimistic);
		expect(store.snapshot).toEqual(optimistic);

		rollback();

		expect(store.snapshot).toEqual(previous);
	});

	it('does not roll back over a newer snapshot', () => {
		const store = new RemoteSettingsStore();
		const previous = makeRemoteSettingsSnapshot({
			version: 1,
			ui: { pinnedInsertPosition: 'top' },
		});
		const optimistic = makeRemoteSettingsSnapshot({
			version: 1,
			ui: { pinnedInsertPosition: 'bottom' },
		});
		const newer = makeRemoteSettingsSnapshot({
			version: 2,
			ui: { pinnedInsertPosition: 'bottom' },
		});
		store.applySnapshot(previous);

		const rollback = store.applyOptimisticSnapshot(optimistic);
		store.applySnapshot(newer);
		rollback();

		expect(store.snapshot).toEqual(newer);
	});
});
