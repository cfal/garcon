import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewChatFormState } from '../new-chat-form-state.svelte';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import { createExecutorStartupFixture, executorStartupSnapshot } from './executor-startup-fixture';

vi.mock('$lib/api/chats', () => ({ validateStart: vi.fn().mockResolvedValue({ valid: true, isGitRepo: false }) }));
vi.mock('$lib/api/chat-preambles', () => ({ preambleSelectionPreview: vi.fn() }));

describe('new chat executor initialization', () => {
	const forms: NewChatFormState[] = [];
	beforeEach(() => {
		localStorage.clear();
		vi.useFakeTimers();
	});
	afterEach(() => {
		for (const form of forms.splice(0)) form.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function fixture() {
		const deps = createExecutorStartupFixture();
		const form: NewChatFormState = new NewChatFormState({
			...deps,
			get selectableAgentIds() {
				return deps.modelCatalog.forExecutor(form.executorId).getSelectableAgents();
			},
		});
		forms.push(form);
		return { ...deps, form };
	}

	it('restores the last executor before resolving its path, agent and model', async () => {
		const { form, modelCatalog, remoteCatalog } = fixture();
		await form.loadSettingsAndModels();
		expect(form.executorId).toBe(remoteExecutor.id);
		expect(form.projectPath).toBe('/worker/recent');
		expect(form.pinnedProjectPaths).toEqual(['/worker/pinned']);
		expect(form.agentId).toBe('codex');
		expect(form.modelValue).toBe('worker-saved');
		expect(modelCatalog.refreshIfStale).not.toHaveBeenCalled();
		expect(remoteCatalog.refreshIfStale).toHaveBeenCalled();
	});

	it.each(['empty', 'local'] as const)('starts on Local with %s history', async kind => {
		const { form, remoteSettings } = fixture();
		const snapshot = executorStartupSnapshot();
		snapshot.recentAgentSettings = kind === 'empty' ? [] : snapshot.recentAgentSettings.slice(1);
		remoteSettings.applySnapshot(snapshot);
		await form.loadSettingsAndModels();
		expect(form.executorId).toBe('local');
		expect(form.projectPath).toBe('/local/recent');
	});

	it.each(['missing-model', 'missing-agent'] as const)('keeps the newest host despite its %s', async reason => {
		const { form, remoteCatalog } = fixture();
		if (reason === 'missing-agent') delete remoteCatalog.agentMetadata.codex;
		else remoteCatalog.agentModels.codex = [];
		await form.loadSettingsAndModels();
		expect(form.executorId).toBe(remoteExecutor.id);
		expect(form.projectPath).toBe('/worker/recent');
		expect(form.modelValue).not.toBe('local-saved');
	});

	it.each(['offline', 'disabled', 'missing'] as const)('preserves the remembered %s executor without permitting submission', async availability => {
		const { form, executors } = fixture();
		executors.applySnapshot(availability === 'missing' ? [localExecutor] : [localExecutor, {
			...remoteExecutor, enabled: availability !== 'disabled', availability: 'offline',
		}]);
		await form.loadSettingsAndModels();
		form.validationStatus = 'valid';
		form.firstMessage = 'Synthetic prompt';
		expect(form.executorId).toBe(remoteExecutor.id);
		expect(form.canSubmit).toBe(false);
		expect(form.buildConfig()).toBeNull();
	});

	it.each(['local', remoteExecutor.id])('preserves an explicit %s choice and edits while settings load', async executorId => {
		const { form, remoteSettings } = fixture();
		const settings = Promise.withResolvers<RemoteSettingsSnapshot>();
		vi.spyOn(remoteSettings, 'ensureLoaded').mockReturnValue(settings.promise);
		const loading = form.loadSettingsAndModels();
		form.selectExecutor(executorId);
		form.projectPath = '/explicit/path';
		form.selectAgent('claude');
		form.selectModel(executorId === 'local' ? 'local-edited' : 'worker-edited');
		form.setThinkingMode('high');
		settings.resolve(executorStartupSnapshot());
		await loading;
		expect(form.executorId).toBe(executorId);
		expect(form.projectPath).toBe('/explicit/path');
		expect(form.agentId).toBe('claude');
		expect(form.modelValue).toBe(executorId === 'local' ? 'local-edited' : 'worker-edited');
		expect(form.thinkingMode).toBe('high');
	});

	it('recognizes an explicit selection of the provisional Local host before loading', async () => {
		const { form } = fixture();
		form.selectExecutor('local');
		await form.loadSettingsAndModels();
		expect(form.executorId).toBe('local');
		expect(form.modelValue).toBe('local-saved');
	});

	it.each(['executor', 'model'] as const)('hydrates untouched execution defaults after an early %s choice', async choice => {
		const { form, remoteSettings } = fixture();
		const settings = Promise.withResolvers<RemoteSettingsSnapshot>();
		vi.spyOn(remoteSettings, 'ensureLoaded').mockReturnValue(settings.promise);
		const loading = form.loadSettingsAndModels();
		if (choice === 'executor') form.selectExecutor(remoteExecutor.id);
		else form.selectModel('local-edited');
		const snapshot = executorStartupSnapshot();
		const saved = { ownerId: 'claude', schemaVersion: 1, values: { thinkingMode: 'auto' } };
		snapshot.executionDefaults.byAgent.claude = {
			permissionMode: 'acceptEdits', thinkingMode: 'high', agentSettingsById: { claude: saved },
		};
		settings.resolve(snapshot);
		await loading;
		expect(form.permissionMode).toBe('acceptEdits');
		expect(form.thinkingMode).toBe('high');
		expect(form.agentSettings).toEqual(saved);
	});

	it.each(['edited', 'restored'] as const)('preserves %s execution modes and agent settings during hydration', async kind => {
		const { form, remoteSettings } = fixture();
		const settings = Promise.withResolvers<RemoteSettingsSnapshot>();
		vi.spyOn(remoteSettings, 'ensureLoaded').mockReturnValue(settings.promise);
		const loading = form.loadSettingsAndModels();
		form.setPermissionMode('acceptEdits');
		form.setThinkingMode('high');
		const explicit = { ownerId: 'claude', schemaVersion: 1, values: { thinkingMode: 'explicit' } };
		if (kind === 'restored') form.replaceAgentSettingsById({ claude: explicit });
		else form.setAgentSetting({ key: 'thinkingMode', label: 'Thinking', type: 'string' }, 'explicit');
		const snapshot = executorStartupSnapshot();
		snapshot.executionDefaults.global.agentSettingsById.claude = { ...explicit, values: { thinkingMode: 'workspace-default' } };
		settings.resolve(snapshot);
		await loading;
		expect(form.permissionMode).toBe('acceptEdits');
		expect(form.thinkingMode).toBe('high');
		expect(form.agentSettings).toEqual(explicit);
	});

	it.each(['permission', 'thinking'] as const)('hydrates the untouched mode when only %s was edited', async edited => {
		const { form, remoteSettings } = fixture();
		const snapshot = executorStartupSnapshot();
		snapshot.executionDefaults.byAgent.claude = { permissionMode: 'acceptEdits', thinkingMode: 'high' };
		remoteSettings.applySnapshot(snapshot);
		if (edited === 'permission') form.setPermissionMode('default');
		else form.setThinkingMode('none');
		await form.loadSettingsAndModels();
		expect(form.permissionMode).toBe(edited === 'permission' ? 'default' : 'acceptEdits');
		expect(form.thinkingMode).toBe(edited === 'thinking' ? 'none' : 'high');
	});

	it('does not move an entered Local directory to the remembered executor', async () => {
		const { form } = fixture();
		form.projectPath = '/local/explicit';
		await form.loadSettingsAndModels();
		expect(form.executorId).toBe('local');
		expect(form.projectPath).toBe('/local/explicit');
	});

	it.each(['permission', 'thinking'] as const)('applies the untouched mode default on agent switch after editing %s', async edited => {
		const { form, remoteSettings } = fixture();
		const snapshot = executorStartupSnapshot();
		snapshot.executionDefaults.byAgent.codex = { permissionMode: 'acceptEdits', thinkingMode: 'high' };
		remoteSettings.applySnapshot(snapshot);
		form.selectExecutor('local');
		await form.loadSettingsAndModels();
		if (edited === 'permission') form.setPermissionMode('default');
		else form.setThinkingMode('none');
		form.selectAgent('codex');
		expect(form.permissionMode).toBe(edited === 'permission' ? 'default' : 'acceptEdits');
		expect(form.thinkingMode).toBe(edited === 'thinking' ? 'none' : 'high');
	});

	it('restores a cold remote recent after discovery without borrowing Local models', async () => {
		const { form, remoteCatalog } = fixture();
		const discovery = Promise.withResolvers<void>();
		const savedModels = remoteCatalog.agentModels;
		const savedMetadata = remoteCatalog.agentMetadata;
		remoteCatalog.agentModels = {};
		remoteCatalog.agentMetadata = {};
		remoteCatalog.lastValidatedAt = null;
		vi.mocked(remoteCatalog.refreshIfStale).mockReturnValue(discovery.promise);
		await form.loadSettingsAndModels();
		expect(form.executorId).toBe(remoteExecutor.id);
		expect(form.modelSelectionPending).toBe(true);
		remoteCatalog.agentMetadata = savedMetadata;
		remoteCatalog.agentModels = savedModels;
		remoteCatalog.lastValidatedAt = Date.now();
		discovery.resolve();
		await discovery.promise;
		await vi.waitFor(() => expect(form.agentId).toBe('codex'));
		expect(form.modelValue).toBe('worker-saved');
	});

	it('ignores old discovery and new settings snapshots after an explicit host change', async () => {
		const { form, remoteCatalog, remoteSettings } = fixture();
		const discovery = Promise.withResolvers<void>();
		vi.mocked(remoteCatalog.refreshIfStale).mockReturnValue(discovery.promise);
		await form.loadSettingsAndModels();
		form.selectExecutor('local');
		form.selectModel('local-edited');
		form.projectPath = '/local/edited';
		remoteSettings.applySnapshot({ ...executorStartupSnapshot(), version: 2 });
		discovery.resolve();
		await discovery.promise;
		expect(form.executorId).toBe('local');
		expect(form.projectPath).toBe('/local/edited');
		expect(form.modelValue).toBe('local-edited');
	});

	it.each([false, true])('reconciles the remembered model after failed cold discovery (edited: %s)', async edited => {
		const { form, remoteCatalog } = fixture();
		const models = remoteCatalog.agentModels;
		const metadata = remoteCatalog.agentMetadata;
		remoteCatalog.agentModels = {};
		remoteCatalog.agentMetadata = {};
		remoteCatalog.lastValidatedAt = null;
		remoteCatalog.error = 'Executor unavailable';
		await form.loadSettingsAndModels();
		await Promise.resolve();
		expect(form.executorId).toBe(remoteExecutor.id);
		remoteCatalog.agentModels = models;
		remoteCatalog.agentMetadata = metadata;
		remoteCatalog.error = null;
		remoteCatalog.lastValidatedAt = Date.now();
		if (edited) {
			form.selectAgent('claude');
			form.selectModel('worker-edited');
		}
		form.validateAllModelsAgainstLive();
		expect(form.agentId).toBe(edited ? 'claude' : 'codex');
		expect(form.modelValue).toBe(edited ? 'worker-edited' : 'worker-saved');
	});
});
