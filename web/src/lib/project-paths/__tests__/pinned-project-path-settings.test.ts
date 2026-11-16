import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import {
	executorPinnedProjectPaths,
	togglePinnedProjectPathOptimistically,
} from '$lib/project-paths/pinned-project-path-settings.js';
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
		features: {
			transcriptSearch: { enabled: false },
			agentCommands: { enabled: true, chatIdDiscovery: true, sendMessage: true, startAgent: true, resumeAgent: true, schedule: true, tickets: true },
		},
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('pinned project path settings', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('preserves optimistic pin age before persistence resolves', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeSnapshot({
				paths: {
					pinnedProjectPaths: ['/workspace/zeta'],
					browseStartPath: '',
					recentProjectPaths: [],
				},
			}),
		);
		const pending = deferred<Awaited<ReturnType<typeof settingsApi.updateRemoteSettings>>>();
		mockedSettingsApi.updateRemoteSettings.mockReturnValueOnce(pending.promise);

		const updatePromise = togglePinnedProjectPathOptimistically(store, '/workspace/alpha');
		await Promise.resolve();

		expect(store.snapshot?.paths.pinnedProjectPaths).toEqual([
			'/workspace/zeta',
			'/workspace/alpha',
		]);
		expect(mockedSettingsApi.updateRemoteSettings).toHaveBeenCalledWith({
			paths: {
				pinnedProjectPaths: ['/workspace/zeta', '/workspace/alpha'],
			},
		});

		pending.resolve({
			success: true,
			settings: makeSnapshot({
				version: 2,
				paths: {
					pinnedProjectPaths: ['/workspace/zeta', '/workspace/alpha'],
					browseStartPath: '',
					recentProjectPaths: [],
				},
			}),
		});
		await updatePromise;

		expect(store.snapshot?.version).toBe(2);
	});

	it.each(['local', '22222222-2222-4222-8222-222222222222'])(
		'optimistically replaces the oldest pin only on %s and rolls back pins and saved paths on failure',
		async (executorId) => {
			const store = new RemoteSettingsStore();
			const pins = ['/z', '/b', '/c', '/d', '/a'];
			const previous = makeSnapshot({ paths: {
				pinnedProjectPaths: pins,
				browseStartPath: '',
				recentProjectPaths: ['/recent'],
				byExecutor: { '22222222-2222-4222-8222-222222222222': { pinnedPaths: pins, recentPaths: ['/recent'] } },
			} });
			store.applySnapshot(previous);
			const pending = deferred<Awaited<ReturnType<typeof settingsApi.updateRemoteSettings>>>();
			mockedSettingsApi.updateRemoteSettings.mockReturnValueOnce(pending.promise);
			const updating = togglePinnedProjectPathOptimistically(store, '/new', { executorId });
			await Promise.resolve();
			const updated = store.snapshot!.paths;
			const expected = { pinnedPaths: ['/b', '/c', '/d', '/a', '/new'], recentPaths: ['/z', '/recent'] };
			if (executorId === 'local') {
				expect(updated.pinnedProjectPaths).toEqual(expected.pinnedPaths);
				expect(updated.recentProjectPaths).toEqual(expected.recentPaths);
				expect(updated.byExecutor).toEqual(previous.paths.byExecutor);
			} else {
				expect(updated.byExecutor?.[executorId]).toEqual(expected);
				expect(updated.pinnedProjectPaths).toEqual(pins);
				expect(updated.recentProjectPaths).toEqual(['/recent']);
			}
			pending.reject(new Error('save failed'));
			await expect(updating).rejects.toThrow('save failed');
			expect(store.snapshot?.paths).toEqual(previous.paths);
		},
	);

	it('rolls back the optimistic snapshot when persistence fails', async () => {
		const store = new RemoteSettingsStore();
		const previous = makeSnapshot({
			paths: {
				pinnedProjectPaths: ['/workspace/zeta'],
				browseStartPath: '',
				recentProjectPaths: [],
			},
		});
		store.applySnapshot(previous);
		mockedSettingsApi.updateRemoteSettings.mockRejectedValueOnce(new Error('settings failed'));

		await expect(togglePinnedProjectPathOptimistically(store, '/workspace/alpha')).rejects.toThrow(
			'settings failed',
		);

		expect(store.snapshot?.paths.pinnedProjectPaths).toEqual(['/workspace/zeta']);
	});

	it('sends only the selected remote executor pins, never stale recents or other executors', async () => {
		const executorId = '22222222-2222-4222-8222-222222222222';
		const otherId = '33333333-3333-4333-8333-333333333333';
		const store = new RemoteSettingsStore();
		const snap = makeSnapshot();
		snap.paths.byExecutor = {
			[executorId]: { defaultPath: '/default', recentPaths: ['/old'], pinnedPaths: [] },
			[otherId]: { recentPaths: [], pinnedPaths: ['/other'] },
		};
		store.applySnapshot(snap);
		const pending = deferred<Awaited<ReturnType<typeof settingsApi.updateRemoteSettings>>>();
		mockedSettingsApi.updateRemoteSettings.mockReturnValueOnce(pending.promise);
		const updating = togglePinnedProjectPathOptimistically(store, '/pin', { executorId });
		await Promise.resolve();
		expect(mockedSettingsApi.updateRemoteSettings).toHaveBeenCalledWith({ paths: { byExecutor: { [executorId]: { pinnedPaths: ['/pin'] } } } });
		expect(store.snapshot?.paths.byExecutor).toEqual({ ...snap.paths.byExecutor, [executorId]: { ...snap.paths.byExecutor[executorId], pinnedPaths: ['/pin'] } });
		const current = makeSnapshot({ version: 2, paths: { ...snap.paths, byExecutor: {
			[executorId]: { defaultPath: '/default', recentPaths: ['/new', '/old'], pinnedPaths: ['/pin'] },
			[otherId]: { recentPaths: [], pinnedPaths: ['/other-new'] },
		} } });
		pending.resolve({ success: true, settings: current });
		await updating;
		expect(store.snapshot?.paths).toEqual(current.paths);
	});

	it('reads the pins of the requested executor only', () => {
		const executorId = '22222222-2222-4222-8222-222222222222';
		const snap = makeSnapshot({
			paths: { pinnedProjectPaths: ['/local-pin'], browseStartPath: '', recentProjectPaths: [] },
		});
		snap.paths.byExecutor = { [executorId]: { recentPaths: ['/recent'], pinnedPaths: ['/worker-pin'] } };

		expect(executorPinnedProjectPaths(snap, 'local')).toEqual(['/local-pin']);
		expect(executorPinnedProjectPaths(snap, null)).toEqual(['/local-pin']);
		expect(executorPinnedProjectPaths(snap, executorId)).toEqual(['/worker-pin']);
		expect(executorPinnedProjectPaths(snap, '33333333-3333-4333-8333-333333333333')).toEqual([]);
		expect(executorPinnedProjectPaths(null, executorId)).toEqual([]);
	});
});
