import { vi } from 'vitest';
import { updateRemoteSettings } from '$lib/api/settings.js';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import type { RemoteSettingsStore } from '../remote-settings.svelte.js';

type SnapshotOverrides = Partial<Omit<RemoteSettingsSnapshot, 'paths' | 'executionDefaults'>> & {
	paths?: Partial<RemoteSettingsSnapshot['paths']>;
	executionDefaults?: {
		global?: Partial<RemoteSettingsSnapshot['executionDefaults']['global']>;
		byAgent?: RemoteSettingsSnapshot['executionDefaults']['byAgent'];
	};
};

export function makeRemoteSettingsSnapshot(
	overrides: SnapshotOverrides = {},
): RemoteSettingsSnapshot {
	const snapshot: RemoteSettingsSnapshot = {
		version: 1,
		features: {
			transcriptSearch: { enabled: false },
			agentCommands: {
				enabled: true,
				chatIdDiscovery: true,
				sendMessage: true,
			},
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
	};
	return {
		...snapshot,
		...overrides,
		paths: {
			...snapshot.paths,
			...(overrides.paths ?? {}),
		},
		executionDefaults: {
			global: {
				...snapshot.executionDefaults.global,
				...(overrides.executionDefaults?.global ?? {}),
			},
			byAgent: {
				...snapshot.executionDefaults.byAgent,
				...(overrides.executionDefaults?.byAgent ?? {}),
			},
		},
	};
}

export function mockRemoteSettingsUpdate(store: RemoteSettingsStore): void {
	vi.mocked(updateRemoteSettings).mockImplementation(async (patch) => {
		const current = store.snapshot ?? makeRemoteSettingsSnapshot();
		const nextUi = {
			...current.ui,
			...(patch.ui ?? {}),
		};
		const nextUiEffective = { ...current.uiEffective };
		const nextFeatures = {
			...current.features,
			transcriptSearch: {
				...current.features.transcriptSearch,
				...(patch.features?.transcriptSearch ?? {}),
			},
			agentCommands: {
				...current.features.agentCommands,
				...(patch.features?.agentCommands ?? {}),
			},
		};
		if (patch.ui?.chatTitle) {
			nextUiEffective.chatTitle = {
				...(current.uiEffective.chatTitle ?? {
					enabled: true,
					agentId: 'claude',
					model: 'opus',
					thinkingMode: 'none',
				}),
				...patch.ui.chatTitle,
			};
		}
		if (patch.ui?.agentSwitchCompaction) {
			nextUiEffective.agentSwitchCompaction = {
				...(current.uiEffective.agentSwitchCompaction ?? {
					enabled: false,
					agentId: 'claude',
					model: 'opus',
					thinkingMode: 'none',
					contextWindowTokens: 500_000,
				}),
				...patch.ui.agentSwitchCompaction,
			};
		}
		if (patch.ui?.commitMessage) {
			nextUiEffective.commitMessage = {
				...(current.uiEffective.commitMessage ?? {
					agentId: 'claude',
					model: 'opus',
					thinkingMode: 'none',
				}),
				...patch.ui.commitMessage,
			};
		}
		if (patch.ui?.promptRefinement) {
			nextUiEffective.promptRefinement = {
				...(current.uiEffective.promptRefinement ?? {
					agentId: 'claude',
					model: 'opus',
					thinkingMode: 'none',
				}),
				...patch.ui.promptRefinement,
			};
		}
		return {
			success: true,
			settings: makeRemoteSettingsSnapshot({
				...current,
				version: current.version + 1,
				ui: nextUi,
				uiEffective: nextUiEffective,
				features: nextFeatures,
			}),
		};
	});
}
