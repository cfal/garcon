import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteSettingsStore } from '../remote-settings.svelte';
import type { RemoteSettingsSnapshot } from '$shared/settings';

vi.mock('$lib/api/settings.js', () => ({
	getRemoteSettings: vi.fn(),
	updateRemoteSettings: vi.fn(),
}));

const settingsApi = await import('$lib/api/settings.js');
const mockedSettingsApi = vi.mocked(settingsApi);

function makeSnapshot(overrides: Partial<RemoteSettingsSnapshot> = {}): RemoteSettingsSnapshot {
	return {
		version: 1,
		features: { transcriptSearch: { enabled: false } },
		ui: {},
		uiEffective: {},
		paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
		pinnedChatIds: [],
		recentAgentSettings: [
			{
				agentId: 'claude',
				model: 'opus',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			},
		],
		executionDefaults: {
			global: {
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettingsById: {},
			},
			byAgent: {},
		},
		projectBasePath: '/workspace',
		telegram: {
			botTokenAvailable: false,
			botUsername: null,
			botFirstName: null,
			recipientUsername: null,
			recipientDisplayName: null,
			recipientLinked: false,
			pendingLink: false,
			linkUrl: null,
		},
		...overrides,
	};
}

describe('RemoteSettingsStore', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('loads the initial snapshot through ensureLoaded', async () => {
		mockedSettingsApi.getRemoteSettings.mockResolvedValue(makeSnapshot({ version: 3 }));
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

	it('ignores stale refresh responses after a newer snapshot is already applied', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot({ version: 5, ui: { pinnedInsertPosition: 'top' } }));
		mockedSettingsApi.getRemoteSettings.mockResolvedValue(
			makeSnapshot({ version: 4, ui: { pinnedInsertPosition: 'bottom' } }),
		);

		const snapshot = await store.refresh();

		expect(snapshot.version).toBe(5);
		expect(store.snapshot?.version).toBe(5);
		expect(store.snapshot?.ui.pinnedInsertPosition).toBe('top');
	});

	it('swallows background refresh failures while preserving the cached snapshot', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot({ version: 5, ui: { pinnedInsertPosition: 'top' } }));
		mockedSettingsApi.getRemoteSettings.mockRejectedValue(new Error('refresh failed'));

		await expect(store.refreshInBackground()).resolves.toBeUndefined();

		expect(store.snapshot?.version).toBe(5);
		expect(store.snapshot?.ui.pinnedInsertPosition).toBe('top');
		expect(store.status).toBe('ready');
		expect(store.error).toBe('refresh failed');
	});

	it('applies newer update responses', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot({ version: 1 }));
		mockedSettingsApi.updateRemoteSettings.mockResolvedValue({
			success: true,
			settings: makeSnapshot({ version: 2, ui: { pinnedInsertPosition: 'bottom' } }),
		});

		const snapshot = await store.update({ ui: { pinnedInsertPosition: 'bottom' } });

		expect(snapshot.version).toBe(2);
		expect(store.snapshot?.version).toBe(2);
		expect(store.snapshot?.ui.pinnedInsertPosition).toBe('bottom');
	});

	it('ignores stale update responses after a newer snapshot arrives', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot({ version: 4, ui: { pinnedInsertPosition: 'top' } }));
		mockedSettingsApi.updateRemoteSettings.mockResolvedValue({
			success: true,
			settings: makeSnapshot({ version: 3, ui: { pinnedInsertPosition: 'bottom' } }),
		});

		const snapshot = await store.update({ ui: { pinnedInsertPosition: 'bottom' } });

		expect(snapshot.version).toBe(4);
		expect(store.snapshot?.version).toBe(4);
		expect(store.snapshot?.ui.pinnedInsertPosition).toBe('top');
	});

	it('rolls back an optimistic snapshot when it is still current', () => {
		const store = new RemoteSettingsStore();
		const previous = makeSnapshot({ version: 1, ui: { pinnedInsertPosition: 'top' } });
		const optimistic = makeSnapshot({ version: 1, ui: { pinnedInsertPosition: 'bottom' } });
		store.applySnapshot(previous);

		const rollback = store.applyOptimisticSnapshot(optimistic);
		expect(store.snapshot).toEqual(optimistic);

		rollback();

		expect(store.snapshot).toEqual(previous);
	});

	it('does not roll back over a newer snapshot', () => {
		const store = new RemoteSettingsStore();
		const previous = makeSnapshot({ version: 1, ui: { pinnedInsertPosition: 'top' } });
		const optimistic = makeSnapshot({ version: 1, ui: { pinnedInsertPosition: 'bottom' } });
		const newer = makeSnapshot({ version: 2, ui: { pinnedInsertPosition: 'bottom' } });
		store.applySnapshot(previous);

		const rollback = store.applyOptimisticSnapshot(optimistic);
		store.applySnapshot(newer);
		rollback();

		expect(store.snapshot).toEqual(newer);
	});
});
