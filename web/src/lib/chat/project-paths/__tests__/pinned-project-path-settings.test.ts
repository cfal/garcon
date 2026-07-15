import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import { togglePinnedProjectPathOptimistically } from '$lib/chat/project-paths/pinned-project-path-settings.js';
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
				claudeThinkingMode: 'auto',
				ampAgentMode: 'smart',
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

	it('applies sorted optimistic pinned paths before persistence resolves', async () => {
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
			'/workspace/alpha',
			'/workspace/zeta',
		]);
		expect(mockedSettingsApi.updateRemoteSettings).toHaveBeenCalledWith({
			paths: {
				pinnedProjectPaths: ['/workspace/alpha', '/workspace/zeta'],
			},
		});

		pending.resolve({
			success: true,
			settings: makeSnapshot({
				version: 2,
				paths: {
					pinnedProjectPaths: ['/workspace/alpha', '/workspace/zeta'],
					browseStartPath: '',
					recentProjectPaths: [],
				},
			}),
		});
		await updatePromise;

		expect(store.snapshot?.version).toBe(2);
	});

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
});
