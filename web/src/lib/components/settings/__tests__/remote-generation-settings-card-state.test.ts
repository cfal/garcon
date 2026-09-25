import { describe, expect, it, vi } from 'vitest';
import {
	RemoteGenerationSettingsCardState,
	type RemoteGenerationSettingsModelCatalog,
	type RemoteGenerationSettingsStore,
} from '../remote-generation-settings-card-state.svelte.ts';
import type { RemoteSettingsSnapshot } from '$shared/settings';

function snapshot(): RemoteSettingsSnapshot {
	const selection = {
		agentId: 'codex',
		model: 'gpt-stale',
		apiProviderId: 'stale',
		modelEndpointId: 'stale_openai',
		modelProtocol: 'openai-compatible' as const,
		thinkingMode: 'medium' as const,
	};
	return {
		version: 1,
		features: {
			transcriptSearch: { enabled: false },
			agentCommands: {
				enabled: true,
				chatIdDiscovery: true,
				sendMessage: true,
				startAgent: true,
				resumeAgent: true,
				schedule: true,
				tickets: true,
			},
		},
		ui: { promptRefinement: { ...selection, customPrompt: 'Original' } },
		uiEffective: { promptRefinement: selection },
		paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
		pinnedChatIds: [],
		recentAgentSettings: [],
		executionDefaults: {
			global: { permissionMode: 'default', thinkingMode: 'none', agentSettingsById: {} },
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
}

describe('RemoteGenerationSettingsCardState', () => {
	it.each(['chatTitle', 'agentSwitchCompaction', 'commitMessage', 'promptRefinement'] as const)(
		'never fills incomplete %s routing during unrelated saves',
		async (settingsKey) => {
			const current = snapshot();
			const saved = {
				executorId: '22222222-2222-4222-8222-222222222222',
				model: 'synthetic-model',
				enabled: true,
				contextWindowTokens: 1_000_000 as const,
				useCommonDirPrefix: true,
			};
			current.ui[settingsKey] = saved;
			current.uiEffective = {};
			const update = vi.fn<RemoteGenerationSettingsStore['update']>(async () => current);
			const cardState = new RemoteGenerationSettingsCardState({
				remoteSettings: { snapshot: current, update },
				modelCatalog: { selectionFor: () => null, selectionValueFor: (_agent, model) => model },
				get settingsKey() {
					return settingsKey;
				},
				get enabledLabel() {
					return 'Enabled';
				},
			});
			if (settingsKey === 'chatTitle' || settingsKey === 'agentSwitchCompaction') {
				await cardState.persistEnabled(false);
				expect(update).toHaveBeenLastCalledWith({
					ui: { [settingsKey]: { ...saved, enabled: false } },
				});
			}
			if (settingsKey === 'agentSwitchCompaction') {
				expect(cardState.contextWindowTokens).toBe(1_000_000);
				await cardState.persistContextWindowTokens(200_000);
				expect(update).toHaveBeenLastCalledWith({
					ui: { [settingsKey]: { ...saved, contextWindowTokens: 200_000 } },
				});
			}
			if (settingsKey === 'commitMessage') {
				expect(cardState.directoryPrefixEnabled).toBe(true);
				await cardState.persistDirectoryPrefixEnabled(false);
				expect(update).toHaveBeenLastCalledWith({
					ui: { [settingsKey]: { ...saved, useCommonDirPrefix: false } },
				});
			}
			if (settingsKey === 'commitMessage' || settingsKey === 'promptRefinement') {
				await cardState.persistPrompt('Synthetic prompt');
				expect(update).toHaveBeenLastCalledWith({
					ui: { [settingsKey]: { ...saved, customPrompt: 'Synthetic prompt' } },
				});
			}
		},
	);
	it.each(['chatTitle', 'agentSwitchCompaction', 'commitMessage', 'promptRefinement'] as const)(
		'retains unavailable %s selections when the snapshot has no effective config',
		(settingsKey) => {
			for (const executorId of ['not-a-executor', '', '22222222-2222-4222-8222-222222222222']) {
				const current = snapshot();
				current.ui[settingsKey] = { executorId, enabled: true, agentId: 'codex' };
				current.uiEffective = {};
				const cardState = new RemoteGenerationSettingsCardState({
					remoteSettings: { snapshot: current, update: vi.fn() },
					modelCatalog: { selectionFor: () => null, selectionValueFor: (_agent, model) => model },
					get settingsKey() {
						return settingsKey;
					},
					get enabledLabel() {
						return 'Enabled';
					},
				});
				expect(cardState.isAuto).toBe(false);
				expect(cardState.executorId).toBe(executorId);
				expect(cardState.enabled).toBe(true);
				expect(cardState.selectorValue).toMatchObject({ executorId, agentId: 'codex', model: '' });
			}
		},
	);

	it.each(['chatTitle', 'agentSwitchCompaction', 'commitMessage', 'promptRefinement'] as const)(
		'Auto clears the executor/model selection but preserves %s options',
		async (settingsKey) => {
			const current = snapshot();
			const preferences =
				settingsKey === 'chatTitle'
					? { enabled: false }
					: settingsKey === 'agentSwitchCompaction'
						? { enabled: true, contextWindowTokens: 200_000 as const }
						: settingsKey === 'commitMessage'
							? { customPrompt: 'Synthetic prompt', useCommonDirPrefix: true }
							: { customPrompt: 'Synthetic prompt' };
			current.ui[settingsKey] = {
				agentId: 'codex',
				model: 'gpt-stale',
				apiProviderId: 'stale',
				modelEndpointId: 'stale_openai',
				modelProtocol: 'openai-compatible',
				thinkingMode: 'medium',
				...preferences,
				executorId: '22222222-2222-4222-8222-222222222222',
			};
			const update = vi.fn<RemoteGenerationSettingsStore['update']>(async () => current);
			const cardState = new RemoteGenerationSettingsCardState({
				remoteSettings: { snapshot: current, update },
				modelCatalog: { selectionFor: () => null, selectionValueFor: (_agent, model) => model },
				get settingsKey() {
					return settingsKey;
				},
				get enabledLabel() {
					return undefined;
				},
			});
			await cardState.persistAuto();
			expect(update).toHaveBeenCalledWith({ ui: { [settingsKey]: preferences } });
		},
	);

	it('preserves stale endpoint routing when saving unrelated settings', async () => {
		const current = snapshot();
		const update = vi.fn().mockResolvedValue(current);
		const remoteSettings = { snapshot: current, update } satisfies RemoteGenerationSettingsStore;
		const modelCatalog = {
			selectionValueFor: vi.fn((_agentId: string, model: string) => model),
			selectionFor: vi.fn(() => null),
		} satisfies RemoteGenerationSettingsModelCatalog;
		const state = new RemoteGenerationSettingsCardState({
			remoteSettings,
			modelCatalog,
			get settingsKey() {
				return 'promptRefinement' as const;
			},
			get enabledLabel() {
				return undefined;
			},
		});

		await expect(state.persistPrompt('Updated')).resolves.toEqual({ ok: true });
		expect(update).toHaveBeenCalledWith({
			ui: {
				promptRefinement: {
					executorId: 'local',
					agentId: 'codex',
					model: 'gpt-stale',
					apiProviderId: 'stale',
					modelEndpointId: 'stale_openai',
					modelProtocol: 'openai-compatible',
					thinkingMode: 'medium',
					customPrompt: 'Updated',
				},
			},
		});
	});
});
