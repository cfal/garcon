import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NewChatFormState } from '../new-chat-form-state.svelte';
import * as chatsApi from '$lib/api/chats';
import type { ModelOption } from '$lib/stores/model-catalog.svelte';
import type { RemoteSettingsSnapshot } from '$shared/settings';

vi.mock('$lib/api/files', () => ({
	browseDirectory: vi.fn(),
}));

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn(),
}));

type SnapshotOverrides = Partial<Omit<RemoteSettingsSnapshot, 'paths' | 'executionDefaults'>> & {
	paths?: Partial<RemoteSettingsSnapshot['paths']>;
	executionDefaults?: {
		global?: Partial<RemoteSettingsSnapshot['executionDefaults']['global']>;
		byAgent?: RemoteSettingsSnapshot['executionDefaults']['byAgent'];
	};
};

function makeSnapshot(overrides: SnapshotOverrides = {}): RemoteSettingsSnapshot {
	const snapshot: RemoteSettingsSnapshot = {
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

function makeMockRemoteSettings(snap?: RemoteSettingsSnapshot) {
	const store = {
		status: snap ? 'ready' : 'idle',
		isRefreshing: false,
		error: null,
		snapshot: snap ?? null,
		loadedAt: snap ? Date.now() : null,
		get hasSnapshot() {
			return this.snapshot !== null;
		},
		ensureLoaded: vi.fn().mockResolvedValue(snap ?? makeSnapshot()),
		refresh: vi.fn().mockResolvedValue(snap ?? makeSnapshot()),
		update: vi.fn().mockResolvedValue(snap ?? makeSnapshot()),
		applySnapshot: vi.fn(),
		applyOptimisticSnapshot: vi.fn(),
	};
	store.applyOptimisticSnapshot.mockImplementation((next: RemoteSettingsSnapshot) => {
		const previous = store.snapshot;
		store.snapshot = next;
		return () => {
			if (store.snapshot === next) store.snapshot = previous;
		};
	});
	return store;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const mockModelCatalog = {
	agentMetadata: {
		claude: { label: 'Claude' },
		codex: { label: 'Codex' },
		'direct-anthropic-compatible': { label: 'Direct (Anthropic)' },
		'direct-openai-compatible': { label: 'Direct (Chat Completions)' },
	},
	getAgents: vi.fn(() => ['claude', 'codex', 'direct-openai-compatible']),
	getSelectableAgents: vi.fn(() => [
		'claude',
		'codex',
		'direct-anthropic-compatible',
		'direct-openai-compatible',
	]),
	getDefaultModel: vi.fn((agentId: string) => {
		if (agentId === 'claude') return 'opus';
		if (agentId === 'codex') return 'gpt-5.4';
		if (agentId === 'direct-anthropic-compatible') return 'acme_anthropic:acme-sonnet';
		if (agentId === 'direct-openai-compatible') return 'zai_openai:glm-5.1';
		return '';
	}),
	getModels: vi.fn((agentId: string): ModelOption[] => {
		if (agentId === 'claude') return [{ value: 'opus', label: 'Opus' }];
		if (agentId === 'codex') return [{ value: 'gpt-5.4', label: 'GPT-5.4' }];
		if (agentId === 'direct-anthropic-compatible') {
			return [
				{
					value: 'acme_anthropic:acme-sonnet',
					label: 'Acme: Acme Sonnet',
					rawModel: 'acme-sonnet',
					apiProviderId: 'acme',
					endpointId: 'acme_anthropic',
					protocol: 'anthropic-messages',
				},
			];
		}
		if (agentId === 'direct-openai-compatible') {
			return [
				{
					value: 'zai_openai:glm-5.1',
					label: 'Z.AI: GLM-5.1',
					rawModel: 'glm-5.1',
					apiProviderId: 'zai',
					endpointId: 'zai_openai',
					protocol: 'openai-compatible',
				},
			];
		}
		return [];
	}),
	getModelForSelection: vi.fn((agentId: string, model: string, endpointId?: string | null) => {
		const models = mockModelCatalog.getModels(agentId);
		return (
			models.find(
				(entry) =>
					(endpointId ? entry.endpointId === endpointId : true) &&
					(entry.value === model || entry.rawModel === model),
			) ?? null
		);
	}),
	selectionFor: vi.fn((agentId: string, model: string) => {
		if (agentId === 'direct-anthropic-compatible' && model === 'acme_anthropic:acme-sonnet') {
			return {
				model: 'acme-sonnet',
				apiProviderId: 'acme',
				modelEndpointId: 'acme_anthropic',
				modelProtocol: 'anthropic-messages',
			};
		}
		if (agentId === 'direct-openai-compatible' && model === 'zai_openai:glm-5.1') {
			return {
				model: 'glm-5.1',
				apiProviderId: 'zai',
				modelEndpointId: 'zai_openai',
				modelProtocol: 'openai-compatible',
			};
		}
		return {
			model,
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
		};
	}),
	selectionValueFor: vi.fn((agentId: string, model: string, endpointId?: string | null) => {
		if (
			agentId === 'direct-anthropic-compatible' &&
			model === 'acme-sonnet' &&
			endpointId === 'acme_anthropic'
		) {
			return 'acme_anthropic:acme-sonnet';
		}
		if (
			agentId === 'direct-openai-compatible' &&
			model === 'glm-5.1' &&
			endpointId === 'zai_openai'
		) {
			return 'zai_openai:glm-5.1';
		}
		return model;
	}),
	refreshIfStale: vi.fn().mockResolvedValue(undefined),
};

describe('NewChatFormState', () => {
	let formState: NewChatFormState;
	let mockRemoteSettings: ReturnType<typeof makeMockRemoteSettings>;

	beforeEach(() => {
		vi.useFakeTimers();
		mockModelCatalog.getSelectableAgents.mockImplementation(() => [
			'claude',
			'codex',
			'direct-anthropic-compatible',
			'direct-openai-compatible',
		]);
		mockRemoteSettings = makeMockRemoteSettings();
		formState = new NewChatFormState(mockModelCatalog as any, mockRemoteSettings as any);
	});

	it('clears Codex ultra thinking when switching to another agent', () => {
		formState.selectAgent('codex');
		formState.setThinkingMode('ultra');

		formState.selectAgent('claude');

		expect(formState.thinkingMode).toBe('none');
	});

	it('retains ultra thinking for Codex', () => {
		formState.selectAgent('codex');
		formState.setThinkingMode('ultra');

		expect(formState.thinkingMode).toBe('ultra');
	});

	it('initializes with default values', () => {
		expect(formState.agentId).toBe('claude');
		expect(formState.validationStatus).toBe('idle');
		expect(formState.canSubmit).toBe(false);
	});

	it('loads startup defaults from server settings', async () => {
		mockRemoteSettings.ensureLoaded.mockResolvedValue(
			makeSnapshot({
				paths: { recentProjectPaths: ['/workspace/project'] },
				recentAgentSettings: [
					{
						agentId: 'codex',
						model: 'gpt-5.4',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
				],
				executionDefaults: {
					byAgent: {
						codex: {
							permissionMode: 'acceptEdits',
							thinkingMode: 'medium',
							claudeThinkingMode: 'off',
						},
					},
				},
			}),
		);

		await formState.loadSettingsAndModels();

		expect(formState.settingsLoaded).toBe(true);
		expect(formState.agentId).toBe('codex');
		expect(formState.modelValue).toBe('gpt-5.4');
		expect(formState.permissionMode).toBe('acceptEdits');
		expect(formState.thinkingMode).toBe('medium');
		expect(formState.claudeThinkingMode).toBe('off');
		expect(formState.projectPath).toBe('/workspace/project');
	});

	it('offers manual bypass in Claude and non-Claude permission mode menus', () => {
		formState.agentId = 'claude';
		expect(formState.permissionModes).toEqual([
			'default',
			'acceptEdits',
			'manualBypass',
			'bypassPermissions',
			'plan',
		]);

		formState.agentId = 'codex';
		expect(formState.permissionModes).toEqual([
			'default',
			'acceptEdits',
			'manualBypass',
			'bypassPermissions',
		]);
	});

	it('loads API provider startup defaults from server settings', async () => {
		mockRemoteSettings.ensureLoaded.mockResolvedValue(
			makeSnapshot({
				paths: { recentProjectPaths: ['/workspace/project'] },
				recentAgentSettings: [
					{
						agentId: 'direct-openai-compatible',
						model: 'glm-5.1',
						apiProviderId: 'zai',
						modelEndpointId: 'zai_openai',
						modelProtocol: 'openai-compatible',
					},
				],
			}),
		);

		await formState.loadSettingsAndModels();

		expect(formState.agentId).toBe('direct-openai-compatible');
		expect(formState.modelValue).toBe('zai_openai:glm-5.1');
	});

	it('loads Direct Anthropic startup defaults from server settings', async () => {
		mockRemoteSettings.ensureLoaded.mockResolvedValue(
			makeSnapshot({
				paths: { recentProjectPaths: ['/workspace/project'] },
				recentAgentSettings: [
					{
						agentId: 'direct-anthropic-compatible',
						model: 'acme-sonnet',
						apiProviderId: 'acme',
						modelEndpointId: 'acme_anthropic',
						modelProtocol: 'anthropic-messages',
					},
				],
			}),
		);

		await formState.loadSettingsAndModels();

		expect(formState.agentId).toBe('direct-anthropic-compatible');
		expect(formState.modelValue).toBe('acme_anthropic:acme-sonnet');
	});

	it('falls back when Direct Anthropic has no endpoint models', async () => {
		mockModelCatalog.getSelectableAgents.mockReturnValue(['claude', 'codex']);
		mockRemoteSettings.ensureLoaded.mockResolvedValue(
			makeSnapshot({
				paths: { recentProjectPaths: ['/workspace/project'] },
				recentAgentSettings: [
					{
						agentId: 'direct-anthropic-compatible',
						model: 'acme-sonnet',
						apiProviderId: 'acme',
						modelEndpointId: 'acme_anthropic',
						modelProtocol: 'anthropic-messages',
					},
				],
			}),
		);

		await formState.loadSettingsAndModels();

		expect(formState.agentId).toBe('claude');
		expect(formState.modelValue).toBe('opus');
	});

	it('falls back when startup defaults reference a non-agent API provider id', async () => {
		mockRemoteSettings.ensureLoaded.mockResolvedValue(
			makeSnapshot({
				paths: { recentProjectPaths: ['/workspace/project'] },
				recentAgentSettings: [
					{
						agentId: 'zai' as any,
						model: 'glm-5.1',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
				],
			}),
		);

		await formState.loadSettingsAndModels();

		expect(formState.agentId).toBe('claude');
		expect(formState.modelValue).toBe('opus');
	});

	it('normalizes invalid startup defaults from server settings', async () => {
		mockRemoteSettings.ensureLoaded.mockResolvedValue(
			makeSnapshot({
				paths: { recentProjectPaths: ['/workspace/project'] },
				executionDefaults: {
					global: {
						permissionMode: 'bogus' as any,
						thinkingMode: 'very-hard' as any,
						claudeThinkingMode: 'sometimes' as any,
						ampAgentMode: 'unreal' as any,
					},
				},
			}),
		);

		await formState.loadSettingsAndModels();

		expect(formState.permissionMode).toBe('default');
		expect(formState.thinkingMode).toBe('none');
		expect(formState.claudeThinkingMode).toBe('auto');
		expect(formState.ampAgentMode).toBe('smart');
	});

	it('does not replace manually touched execution modes when changing agent', async () => {
		mockRemoteSettings.ensureLoaded.mockResolvedValue(
			makeSnapshot({
				recentAgentSettings: [
					{
						agentId: 'codex',
						model: 'gpt-5.4',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
				],
				executionDefaults: {
					byAgent: {
						claude: {
							permissionMode: 'acceptEdits',
							thinkingMode: 'none',
							claudeThinkingMode: 'on',
							ampAgentMode: 'smart',
						},
						codex: {
							permissionMode: 'bypassPermissions',
							thinkingMode: 'medium',
							claudeThinkingMode: 'off',
							ampAgentMode: 'deep',
						},
					},
				},
			}),
		);

		await formState.loadSettingsAndModels();
		formState.setPermissionMode('manualBypass');
		formState.setThinkingMode('medium');
		formState.selectAgent('claude');

		expect(formState.permissionMode).toBe('manualBypass');
		expect(formState.thinkingMode).toBe('medium');
	});

	it('debounces directory validation', async () => {
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: false });

		formState.projectPath = '/fake/path';
		formState.validatePath();
		expect(formState.validationStatus).toBe('checking');
		expect(chatsApi.validateStart).not.toHaveBeenCalled();

		vi.advanceTimersByTime(500);
		await vi.runAllTimersAsync();

		expect(chatsApi.validateStart).toHaveBeenCalledWith('/fake/path');
		expect(formState.validationStatus).toBe('valid');
	});

	it('maps outside-base-dir validation errors to a specific message', async () => {
		vi.mocked(chatsApi.validateStart).mockResolvedValue({
			valid: false,
			error: 'Path is outside the allowed base directory',
			errorCode: 'outside_base_dir',
		});

		formState.projectPath = '/outside';
		formState.validatePath();
		vi.advanceTimersByTime(500);
		await vi.runAllTimersAsync();

		expect(formState.validationStatus).toBe('invalid');
		expect(formState.validationError).toBe('Path is outside the allowed base directory.');
	});

	it('computes canSubmit correctly', () => {
		formState.settingsLoaded = true;
		formState.projectPath = '/valid/path';
		formState.validationStatus = 'valid';
		expect(formState.canSubmit).toBe(false);

		formState.firstMessage = 'Start this task';
		expect(formState.canSubmit).toBe(true);

		formState.validationStatus = 'invalid';
		expect(formState.canSubmit).toBe(false);
	});

	it('rejects submission while startup defaults are still loading', () => {
		formState.projectPath = '/valid/path';
		formState.validationStatus = 'valid';
		formState.firstMessage = 'Start this task';

		expect(formState.buildConfig()).toBeNull();
		expect(formState.error).toBe('Chat defaults are still loading.');
	});

	it('builds config without persisting startup defaults through app settings', () => {
		formState.settingsLoaded = true;
		formState.projectPath = '/valid/path';
		formState.validationStatus = 'valid';
		formState.firstMessage = 'Start this task';
		formState.agentId = 'codex';
		formState.handleModelChange('gpt-5.4');
		formState.permissionMode = 'acceptEdits';
		formState.thinkingMode = 'medium';
		formState.claudeThinkingMode = 'on';

		const config = formState.buildConfig();

		expect(config).toMatchObject({
			agentId: 'codex',
			projectPath: '/valid/path',
			model: 'gpt-5.4',
			permissionMode: 'acceptEdits',
			thinkingMode: 'medium',
			claudeThinkingMode: 'on',
		});
		expect(mockRemoteSettings.update).not.toHaveBeenCalled();
	});

	it('tracks pending pinned path persistence', async () => {
		const pending = deferred<RemoteSettingsSnapshot>();
		mockRemoteSettings.update.mockReturnValueOnce(pending.promise);
		formState.projectPath = '/workspace/repo';

		const togglePromise = formState.togglePinnedPath();

		expect(formState.isUpdatingPinnedPath).toBe(true);
		expect(formState.pinnedProjectPaths).toEqual(['/workspace/repo']);

		pending.resolve(
			makeSnapshot({
				paths: { pinnedProjectPaths: ['/workspace/repo'] },
			}),
		);
		await togglePromise;

		expect(formState.isUpdatingPinnedPath).toBe(false);
	});

	it('rolls back optimistic pinned path changes when persistence fails', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockRemoteSettings.update.mockRejectedValueOnce(new Error('settings write failed'));
		formState.projectPath = '/workspace/repo';

		try {
			await formState.togglePinnedPath();

			expect(formState.pinnedProjectPaths).toEqual([]);
			expect(formState.isUpdatingPinnedPath).toBe(false);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
