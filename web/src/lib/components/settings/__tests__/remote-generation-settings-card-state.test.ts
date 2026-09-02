import { describe, expect, it, vi } from 'vitest';
import {
	RemoteGenerationSettingsCardState,
	type RemoteGenerationSettingsModelCatalog,
	type RemoteGenerationSettingsStore,
} from '../remote-generation-settings-card-state.svelte';
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
			agentCommands: { enabled: true, chatIdDiscovery: true, sendMessage: true },
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
