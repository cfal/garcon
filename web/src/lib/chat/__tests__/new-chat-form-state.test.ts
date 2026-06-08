import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NewChatFormState } from '../new-chat-form-state.svelte';
import * as chatsApi from '$lib/api/chats';
import type { RemoteSettingsSnapshot } from '$shared/settings';

vi.mock('$lib/api/files', () => ({
	browseDirectory: vi.fn()
}));

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn()
}));

function makeSnapshot(overrides: Partial<RemoteSettingsSnapshot> = {}): RemoteSettingsSnapshot {
	return {
		version: 1,
		ui: {},
		uiEffective: {},
		paths: { pinnedProjectPaths: [], browseStartPath: '' },
		pinnedChatIds: [],
		lastAgentId: 'claude',
		lastProjectPath: '',
		lastModel: 'opus',
		lastApiProviderId: null,
		lastModelEndpointId: null,
		lastModelProtocol: null,
		lastPermissionMode: 'default',
		lastThinkingMode: 'none',
		lastClaudeThinkingMode: 'auto',
		lastAmpAgentMode: 'smart',
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

function makeMockRemoteSettings(snap?: RemoteSettingsSnapshot) {
	const store = {
		status: snap ? 'ready' : 'idle',
		isRefreshing: false,
		error: null,
		snapshot: snap ?? null,
		loadedAt: snap ? Date.now() : null,
		get hasSnapshot() { return this.snapshot !== null; },
		ensureLoaded: vi.fn().mockResolvedValue(snap ?? makeSnapshot()),
		refresh: vi.fn().mockResolvedValue(snap ?? makeSnapshot()),
		update: vi.fn().mockResolvedValue(snap ?? makeSnapshot()),
		applySnapshot: vi.fn(),
	};
	return store;
}

const mockAppShell = {
	onNewChatDialogSeed: vi.fn().mockReturnValue(() => {}),
	projectBasePath: '/',
};
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
		'direct-openai-compatible'
	]),
	getDefaultModel: vi.fn((agentId: string) => {
		if (agentId === 'claude') return 'opus';
		if (agentId === 'codex') return 'gpt-5.4';
		if (agentId === 'direct-anthropic-compatible') return 'acme_anthropic:acme-sonnet';
		if (agentId === 'direct-openai-compatible') return 'zai_openai:glm-5.1';
		return '';
	}),
	getModels: vi.fn((agentId: string) => {
		if (agentId === 'claude') return [{ value: 'opus', label: 'Opus' }];
		if (agentId === 'codex') {
			return [
				{ value: 'gpt-5.4', label: 'GPT-5.4' },
				{ value: 'gpt-5.4-fast', label: 'GPT-5.4 Fast Mode' },
			];
		}
		if (agentId === 'direct-anthropic-compatible') {
			return [{
				value: 'acme_anthropic:acme-sonnet',
				label: 'Acme: Acme Sonnet',
				rawModel: 'acme-sonnet',
				apiProviderId: 'acme',
				endpointId: 'acme_anthropic',
				protocol: 'anthropic-messages',
			}];
		}
		if (agentId === 'direct-openai-compatible') {
			return [{
				value: 'zai_openai:glm-5.1',
				label: 'Z.AI: GLM-5.1',
				rawModel: 'glm-5.1',
				apiProviderId: 'zai',
				endpointId: 'zai_openai',
				protocol: 'openai-compatible',
			}];
		}
		return [];
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
		if (agentId === 'direct-anthropic-compatible' && model === 'acme-sonnet' && endpointId === 'acme_anthropic') {
			return 'acme_anthropic:acme-sonnet';
		}
		if (agentId === 'direct-openai-compatible' && model === 'glm-5.1' && endpointId === 'zai_openai') {
			return 'zai_openai:glm-5.1';
		}
		return model;
	}),
	refreshIfStale: vi.fn().mockResolvedValue(undefined)
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
			'direct-openai-compatible'
		]);
		mockRemoteSettings = makeMockRemoteSettings();
		formState = new NewChatFormState(mockAppShell as any, mockModelCatalog as any, mockRemoteSettings as any);
	});

	it('initializes with default values', () => {
		expect(formState.agentId).toBe('claude');
		expect(formState.validationStatus).toBe('idle');
		expect(formState.canSubmit).toBe(false);
	});

	it('loads startup defaults from server settings', async () => {
		mockRemoteSettings.ensureLoaded.mockResolvedValue(makeSnapshot({
			lastAgentId: 'codex',
			lastProjectPath: '/workspace/project',
			lastModel: 'gpt-5.4',
			lastPermissionMode: 'acceptEdits',
			lastThinkingMode: 'think-hard',
			lastClaudeThinkingMode: 'off',
		}));

		await formState.loadSettingsAndModels();

		expect(formState.settingsLoaded).toBe(true);
		expect(formState.agentId).toBe('codex');
		expect(formState.modelValue).toBe('gpt-5.4');
		expect(formState.permissionMode).toBe('acceptEdits');
		expect(formState.thinkingMode).toBe('think-hard');
		expect(formState.claudeThinkingMode).toBe('off');
		expect(formState.projectPath).toBe('/workspace/project');
	});

	it('uses a matching fast model when fast mode is enabled', async () => {
		formState = new NewChatFormState(
			mockAppShell as any,
			mockModelCatalog as any,
			mockRemoteSettings as any,
			{ fastMode: true }
		);
		mockRemoteSettings.ensureLoaded.mockResolvedValue(makeSnapshot({
			lastAgentId: 'codex',
			lastProjectPath: '/workspace/project',
			lastModel: 'gpt-5.4',
		}));

		await formState.loadSettingsAndModels();

		expect(formState.modelValue).toBe('gpt-5.4-fast');
	});

	it('loads API provider startup defaults from server settings', async () => {
		mockRemoteSettings.ensureLoaded.mockResolvedValue(makeSnapshot({
			lastAgentId: 'direct-openai-compatible',
			lastProjectPath: '/workspace/project',
			lastModel: 'glm-5.1',
			lastApiProviderId: 'zai',
			lastModelEndpointId: 'zai_openai',
			lastModelProtocol: 'openai-compatible',
		}));

		await formState.loadSettingsAndModels();

		expect(formState.agentId).toBe('direct-openai-compatible');
		expect(formState.modelValue).toBe('zai_openai:glm-5.1');
	});

	it('loads Direct Anthropic startup defaults from server settings', async () => {
		mockRemoteSettings.ensureLoaded.mockResolvedValue(makeSnapshot({
			lastAgentId: 'direct-anthropic-compatible',
			lastProjectPath: '/workspace/project',
			lastModel: 'acme-sonnet',
			lastApiProviderId: 'acme',
			lastModelEndpointId: 'acme_anthropic',
			lastModelProtocol: 'anthropic-messages',
		}));

		await formState.loadSettingsAndModels();

		expect(formState.agentId).toBe('direct-anthropic-compatible');
		expect(formState.modelValue).toBe('acme_anthropic:acme-sonnet');
	});

	it('falls back when Direct Anthropic has no endpoint models', async () => {
		mockModelCatalog.getSelectableAgents.mockReturnValue(['claude', 'codex']);
		mockRemoteSettings.ensureLoaded.mockResolvedValue(makeSnapshot({
			lastAgentId: 'direct-anthropic-compatible',
			lastProjectPath: '/workspace/project',
			lastModel: 'acme-sonnet',
			lastApiProviderId: 'acme',
			lastModelEndpointId: 'acme_anthropic',
			lastModelProtocol: 'anthropic-messages',
		}));

		await formState.loadSettingsAndModels();

		expect(formState.agentId).toBe('claude');
		expect(formState.modelValue).toBe('opus');
	});

	it('falls back when startup defaults reference a non-agent API provider id', async () => {
		mockRemoteSettings.ensureLoaded.mockResolvedValue(makeSnapshot({
			lastAgentId: 'zai' as RemoteSettingsSnapshot['lastAgentId'],
			lastProjectPath: '/workspace/project',
			lastModel: 'glm-5.1',
		}));

		await formState.loadSettingsAndModels();

		expect(formState.agentId).toBe('claude');
		expect(formState.modelValue).toBe('opus');
	});

	it('normalizes invalid startup defaults from server settings', async () => {
		mockRemoteSettings.ensureLoaded.mockResolvedValue(makeSnapshot({
			lastPermissionMode: 'bogus' as any,
			lastThinkingMode: 'very-hard' as any,
			lastClaudeThinkingMode: 'sometimes' as any,
			lastProjectPath: '/workspace/project',
		}));

		await formState.loadSettingsAndModels();

		expect(formState.permissionMode).toBe('default');
		expect(formState.thinkingMode).toBe('none');
		expect(formState.claudeThinkingMode).toBe('auto');
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
			errorCode: 'outside_base_dir'
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
		formState.thinkingMode = 'think-hard';
		formState.claudeThinkingMode = 'on';

		const config = formState.buildConfig();

		expect(config).toMatchObject({
			agentId: 'codex',
			projectPath: '/valid/path',
			model: 'gpt-5.4',
			permissionMode: 'acceptEdits',
			thinkingMode: 'think-hard',
			claudeThinkingMode: 'on',
		});
		expect(mockRemoteSettings.update).not.toHaveBeenCalled();
	});
});
