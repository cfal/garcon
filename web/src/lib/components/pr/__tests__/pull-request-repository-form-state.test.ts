import { expect, it, vi } from 'vitest';
import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import {
	DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
	type PullRequestReviewRepository,
	type PullRequestReviewSettings,
} from '$shared/pull-request-reviews';
import type { ExecutorSnapshot } from '$shared/executors';
import { PullRequestRepositoryFormState } from '../pull-request-repository-form-state.svelte';
import { createExecutorStartupFixture } from '$lib/chat/new-chat/__tests__/executor-startup-fixture';
import { remoteExecutor } from '$lib/executors/__tests__/fixtures';

async function offlineForm(settings: PullRequestReviewSettings) {
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
		settings,
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
			tags: [],
			preambleChoice: { mode: 'defaults' },
		},
	} satisfies PullRequestReviewRepository;
	await form.initialize(repository);
	return { form, repository };
}

it('edits and round-trips every automatic-review filter and limit while offline', async () => {
	const settings = {
		...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
		filters: {
			...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.filters,
			baseBranches: ['main', 'release/stable'],
			includeLabels: ['review, please'],
			excludeLabels: ['blocked'],
			maxChangedLines: 1200,
		},
		maxAttemptsPerCommit: 3,
		dailyReviewLimit: 50,
	};
	const { form, repository } = await offlineForm(settings);
	try {
		expect(form.baseBranches).toBe('main\nrelease/stable');
		expect(form.includeLabels).toBe('review, please');
		expect(form.excludeLabels).toBe('blocked');
		expect(form.maxChangedLines).toBe(1200);
		expect(form.maxAttemptsPerCommit).toBe(3);
		expect(form.dailyReviewLimit).toBe(50);
		expect(form.buildInput()?.settings).toEqual(settings);

		form.baseBranches = ' develop \n\n release/next \n develop';
		form.includeLabels = 'ready\nneeds review';
		form.excludeLabels = '';
		form.maxChangedLines = undefined;
		form.maxAttemptsPerCommit = 5;
		form.dailyReviewLimit = 500;
		form.debounceMinutes = 0;
		expect(form.buildInput()).toMatchObject({
			target: repository.target,
			settings: {
				filters: {
					baseBranches: ['develop', 'release/next'],
					includeLabels: ['ready', 'needs review'],
					excludeLabels: [],
					maxChangedLines: null,
				},
				maxAttemptsPerCommit: 5,
				dailyReviewLimit: 500,
				debounceMinutes: 0,
			},
		});
	} finally {
		form.dispose();
	}
});

it('blocks saving invalid filter values and limits before submitting', async () => {
	const { form } = await offlineForm(DEFAULT_PULL_REQUEST_REVIEW_SETTINGS);
	try {
		for (const invalid of [
			{ maxChangedLines: 0 },
			{ maxChangedLines: 1_000_001 },
			{ maxAttemptsPerCommit: undefined },
			{ maxAttemptsPerCommit: 0 },
			{ maxAttemptsPerCommit: 6 },
			{ dailyReviewLimit: 0 },
			{ dailyReviewLimit: 501 },
			{ dailyReviewLimit: 1.5 },
			{ debounceMinutes: undefined },
			{ debounceMinutes: -1 },
			{ debounceMinutes: 1441 },
			{ baseBranches: Array.from({ length: 21 }, (_, index) => `branch-${index}`).join('\n') },
			{ includeLabels: 'a'.repeat(256) },
			{ excludeLabels: 'bad\0label' },
		]) {
			const restore = {
				maxChangedLines: form.maxChangedLines,
				maxAttemptsPerCommit: form.maxAttemptsPerCommit,
				dailyReviewLimit: form.dailyReviewLimit,
				debounceMinutes: form.debounceMinutes,
				baseBranches: form.baseBranches,
				includeLabels: form.includeLabels,
				excludeLabels: form.excludeLabels,
			};
			Object.assign(form, invalid);
			expect(form.canSave, JSON.stringify(invalid)).toBe(false);
			expect(form.settingsError).toBeTruthy();
			expect(form.buildInput()).toBeNull();
			Object.assign(form, restore);
		}
		expect(form.canSave).toBe(true);
	} finally {
		form.dispose();
	}
});

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
		settings: { ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, autoReview: true, autoPost: true },
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
		form.autoPost = false;
		expect(form.canSave).toBe(true);
		expect(form.buildInput()).toMatchObject({
			target: repository.target,
			settings: { autoReview: false, autoPost: false },
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
