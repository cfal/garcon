import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledPromptFormState } from '../scheduled-prompt-form-state.svelte';
import { createExecutorStartupFixture, executorStartupSnapshot } from '$lib/chat/new-chat/__tests__/executor-startup-fixture';
import { remoteExecutor } from '$lib/executors/__tests__/fixtures';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import type { ScheduledPrompt } from '$shared/scheduled-prompts';
import type { JsonObject } from '$shared/json';

function scheduledPrompt(executorId?: string): ScheduledPrompt & { target: Extract<ScheduledPrompt['target'], { type: 'new-chat' }> } {
	return {
		id: 'synthetic-schedule', prompt: 'Synthetic prompt',
		schedule: { type: 'once', nextRunAt: '2030-01-02T09:00:00.000Z' },
		createdAt: '2029-01-01T00:00:00.000Z', updatedAt: '2029-01-01T00:00:00.000Z',
		target: {
			type: 'new-chat', executorId, agentId: 'claude', projectPath: '/saved/project',
			model: executorId && executorId !== 'local' ? 'worker-edited' : 'local-edited',
			apiProviderId: null, modelEndpointId: null, modelProtocol: null,
			permissionMode: 'acceptEdits', thinkingMode: 'high', agentSettingsById: {},
			tags: ['synthetic'], preambleChoice: { mode: 'defaults' },
		},
	};
}

describe('scheduled chat executor initialization', () => {
	const forms: ScheduledPromptFormState[] = [];
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
		const form: ScheduledPromptFormState = new ScheduledPromptFormState(
			deps.modelCatalog, deps.remoteSettings, { hasChat: () => false, isDraft: () => false }, {
				executors: deps.executors,
				get selectableAgentIds() {
					return deps.modelCatalog.forExecutor(form.startup.executorId).getSelectableAgents();
				},
			},
		);
		forms.push(form);
		return { ...deps, form };
	}

	it('inherits the last interactive executor, directory and model for a new schedule', async () => {
		const { form } = fixture();
		await form.initialize(null);
		expect(form.startup.executorId).toBe(remoteExecutor.id);
		expect(form.startup.projectPath).toBe('/worker/recent');
		expect(form.startup.agentId).toBe('codex');
		expect(form.startup.modelValue).toBe('worker-saved');
	});

	it.each([undefined, 'local', remoteExecutor.id])('restores a saved %s target instead of interactive defaults', async executorId => {
		const { form, remoteCatalog, remoteSettings } = fixture();
		const snapshot = executorStartupSnapshot();
		snapshot.executionDefaults.global.agentSettingsById.claude = {
			ownerId: 'claude', schemaVersion: 1, values: { thinkingMode: 'workspace-default' },
		};
		if (executorId === remoteExecutor.id) snapshot.recentAgentSettings.reverse();
		remoteSettings.applySnapshot(snapshot);
		const discovery = Promise.withResolvers<void>();
		vi.mocked(remoteCatalog.refreshIfStale).mockReturnValue(discovery.promise);
		const prompt = scheduledPrompt(executorId);
		await form.initialize(prompt);
		discovery.resolve();
		await discovery.promise;
		form.startup.validationStatus = 'valid';
		expect(form.startup.executorId).toBe(executorId ?? 'local');
		const expectedTarget = { ...prompt.target };
		if (executorId !== remoteExecutor.id) delete expectedTarget.executorId;
		expect(form.buildDefinition(new Date('2029-12-01T00:00:00Z'))?.target).toMatchObject(expectedTarget);
		expect(form.startup.agentSettings.values).toEqual({});
	});

	it('never restores saved values over user edits made while settings are pending', async () => {
		const { form, remoteSettings } = fixture();
		const settings = Promise.withResolvers<RemoteSettingsSnapshot>();
		vi.spyOn(remoteSettings, 'ensureLoaded').mockReturnValue(settings.promise);
		const initializing = form.initialize(scheduledPrompt(remoteExecutor.id));
		expect(form.startup.executorId).toBe(remoteExecutor.id);
		form.startup.selectExecutor('local');
		form.startup.projectPath = '/local/user-edit';
		form.startup.selectAgent('codex');
		form.startup.selectModel('local-edited');
		form.startup.setThinkingMode('none');
		settings.resolve(executorStartupSnapshot());
		await initializing;
		expect(form.startup.executorId).toBe('local');
		expect(form.startup.projectPath).toBe('/local/user-edit');
		expect(form.startup.agentId).toBe('codex');
		expect(form.startup.modelValue).toBe('local-edited');
		expect(form.startup.thinkingMode).toBe('none');
	});

	it.each(['omitted', 'empty', 'configured'] as const)('preserves %s saved agent settings through cold catalog hydration', async kind => {
		const { form, remoteCatalog, remoteSettings } = fixture();
		const snapshot = executorStartupSnapshot();
		snapshot.executionDefaults.global.agentSettingsById.claude = {
			ownerId: 'claude', schemaVersion: 1, values: { thinkingMode: 'workspace-default' },
		};
		remoteSettings.applySnapshot(snapshot);
		const metadata = {
			...remoteCatalog.agentMetadata,
			claude: {
				...remoteCatalog.agentMetadata.claude!,
				defaultSettings: { ownerId: 'claude', schemaVersion: 1, values: { thinkingMode: 'catalog-default' } },
			},
		};
		remoteCatalog.agentMetadata = {};
		remoteCatalog.lastValidatedAt = null;
		const discovery = Promise.withResolvers<void>();
		vi.mocked(remoteCatalog.refreshIfStale).mockReturnValue(discovery.promise);
		const prompt = scheduledPrompt(remoteExecutor.id);
		const savedValues: JsonObject = kind === 'configured' ? { thinkingMode: 'saved' } : {};
		if (kind !== 'omitted') {
			prompt.target.agentSettingsById.claude = { ownerId: 'claude', schemaVersion: 1, values: savedValues };
		}
		await form.initialize(prompt);
		remoteCatalog.agentMetadata = metadata;
		remoteCatalog.lastValidatedAt = Date.now();
		discovery.resolve();
		await vi.waitFor(() => {
			expect(form.startup.agentSettingsById.codex).toBeDefined();
			expect(form.startup.agentSettings.values).toEqual(kind === 'omitted'
				? { thinkingMode: 'catalog-default' }
				: savedValues);
		});
	});
});
