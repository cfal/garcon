import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteSettingsRouter } from './remote-settings-router.svelte';
import type { RemoteSettingsSnapshot } from '$shared/settings';

const { drain, cleanup, createDrainCursor } = vi.hoisted(() => {
	const drain = vi.fn();
	const cleanup = vi.fn();
	return {
		drain,
		cleanup,
		createDrainCursor: vi.fn(() => ({ drain, cleanup })),
	};
});

vi.mock('$lib/ws/drain', () => ({
	createDrainCursor,
}));

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
		browserNotifications: {
			vapidPublicKeyAvailable: false,
			subscriptionCount: 0,
		},
		...overrides,
	};
}

describe('RemoteSettingsRouter', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		drain.mockReturnValue([]);
		createDrainCursor.mockReturnValue({ drain, cleanup });
	});

	it('applies settings-changed snapshots to the remote settings store', () => {
		const store = { applySnapshot: vi.fn() };
		const snapshot = makeSnapshot({ version: 2, ui: { pinnedInsertPosition: 'bottom' } });
		drain.mockReturnValue([{ data: { type: 'settings-changed', settings: snapshot } }]);
		const router = new RemoteSettingsRouter({} as never, store as never);

		router.start();
		router.tick();

		expect(store.applySnapshot).toHaveBeenCalledWith(snapshot);
	});

	it('ignores non-settings websocket messages', () => {
		const store = { applySnapshot: vi.fn() };
		drain.mockReturnValue([{ data: { type: 'chat-session-created', chatId: 'chat-1' } }]);
		const router = new RemoteSettingsRouter({} as never, store as never);

		router.start();
		router.tick();

		expect(store.applySnapshot).not.toHaveBeenCalled();
	});
});
