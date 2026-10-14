import { expect, it, vi } from 'vitest';
import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import {
	DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
	type PullRequestReviewRepository,
} from '$shared/pull-request-reviews';
import type { ExecutorSnapshot } from '$shared/executors';
import { PullRequestRepositoryFormState } from '../pull-request-repository-form-state.svelte';
import { createExecutorStartupFixture } from '$lib/chat/new-chat/__tests__/executor-startup-fixture';
import { remoteExecutor } from '$lib/executors/__tests__/fixtures';

it('saves settings against the preserved offline target without a model catalog', async () => {
	const executors = new ExecutorsStore();
	const id = '11111111-1111-4111-8111-111111111111';
	executors.applySnapshot([
		{
			...executors.executors[0],
			id,
			label: 'Offline reviewer',
			kind: 'remote',
			availability: 'offline',
			direction: 'controller-connects',
			bulk: { availability: 'offline', lastError: null },
		} satisfies ExecutorSnapshot,
	]);
	const form = new PullRequestRepositoryFormState({
		modelCatalog: new ModelCatalogStore(),
		remoteSettings: new RemoteSettingsStore(),
		executors,
		selectableAgentIds: [],
	});
	const repository = {
		id: 'repo',
		nameWithOwner: 'acme/app',
		url: '',
		viewerLogin: 'viewer',
		createdAt: '',
		updatedAt: '',
		scan: { status: 'executor-unavailable', scannedAt: null, message: null },
		settings: { ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, autoReview: true, posting: 'comment' },
		target: {
			type: 'new-chat',
			executorId: id,
			agentId: 'claude',
			model: 'saved-model',
			projectPath: '/work/app',
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
			permissionMode: 'plan',
			thinkingMode: 'high',
			agentSettingsById: {},
			tags: ['review'],
			preambleChoice: { mode: 'defaults' },
		},
	} satisfies PullRequestReviewRepository;
	const load = vi.spyOn(form.startup, 'loadSettingsAndModels');
	try {
		await form.initialize(repository);
		expect(load).not.toHaveBeenCalled();
		expect(form.startup.resolvedModelSelection).toBeNull();
		form.autoReview = false;
		form.posting = 'off';
		expect(form.canSave).toBe(true);
		expect(form.buildInput()).toMatchObject({
			target: repository.target,
			settings: { autoReview: false, posting: 'off' },
		});
		form.startup.projectPath = '/work/other';
		expect(form.canSave).toBe(false);
		expect(form.buildInput()).toBeNull();
	} finally {
		form.dispose();
	}
});

it('loads startup settings after reconnection without losing the saved target or edits', async () => {
	const fixture = createExecutorStartupFixture();
	fixture.executors.applySnapshot([{ ...remoteExecutor, availability: 'offline' }]);
	const form = new PullRequestRepositoryFormState({
		...fixture,
		selectableAgentIds: ['claude', 'codex'],
	});
	const repository = {
		id: 'repo',
		nameWithOwner: 'acme/app',
		url: '',
		viewerLogin: 'viewer',
		createdAt: '',
		updatedAt: '',
		scan: { status: 'executor-unavailable', scannedAt: null, message: null },
		settings: { ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, autoReview: true },
		target: {
			type: 'new-chat',
			executorId: remoteExecutor.id,
			agentId: 'claude',
			model: 'worker-saved',
			projectPath: '/worker/app',
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
			permissionMode: 'default',
			thinkingMode: 'high',
			agentSettingsById: {},
			tags: ['review'],
			preambleChoice: { mode: 'defaults' },
		},
	} satisfies PullRequestReviewRepository;
	const load = vi.spyOn(form.startup, 'loadSettingsAndModels');
	// Path validity is supplied by the executor's validation port in this recovery check.
	vi.spyOn(form.startup, 'validatePath').mockImplementation(() => {
		form.startup.validationStatus = 'valid';
	});
	try {
		await form.initialize(repository);
		expect(form.canSave).toBe(true);
		form.autoReview = false;
		form.prompt = 'Keep the saved reviewer.';
		fixture.executors.applySnapshot([remoteExecutor]);
		await Promise.all([form.loadStartupWhenReady(), form.loadStartupWhenReady()]);
		expect(load).toHaveBeenCalledTimes(1);
		expect(form.startup.settingsLoaded).toBe(true);
		expect(form.canSave).toBe(true);
		expect(form.buildInput()).toMatchObject({
			target: repository.target,
			settings: { autoReview: false, prompt: 'Keep the saved reviewer.' },
		});
	} finally {
		form.dispose();
	}
});
