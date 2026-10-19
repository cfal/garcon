import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte.js';
import {
	DEFAULT_PULL_REQUEST_REVIEW_PROMPT,
	DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
	PULL_REQUEST_REVIEW_PROMPT_MAX_LENGTH,
	normalizePullRequestReviewSettings,
	type PullRequestReviewRepository,
	type PullRequestReviewRepositoryInput,
	type PullRequestReviewSettings,
} from '$shared/pull-request-reviews';
import * as m from '$lib/paraglide/messages.js';

export interface PullRequestRepositoryFormOptions {
	modelCatalog: ModelCatalogStore;
	remoteSettings: RemoteSettingsStore;
	executors: ExecutorsStore;
	get selectableAgentIds(): readonly SessionAgentId[];
}

// Edits one connected repository: where and how its review chats start, and its review settings.
export class PullRequestRepositoryFormState {
	readonly startup: NewChatFormState;
	repositoryId = $state<string | null>(null);
	prompt = $state(DEFAULT_PULL_REQUEST_REVIEW_PROMPT);
	autoReview = $state(DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.autoReview);
	autoPost = $state(DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.autoPost);
	onlyWhenReviewRequested = $state(DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.onlyWhenReviewRequested);
	filters = $state({
		skipDrafts: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.filters.skipDrafts,
		trustedAuthorsOnly: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.filters.trustedAuthorsOnly,
	});
	baseBranches = $state('');
	includeLabels = $state('');
	excludeLabels = $state('');
	maxChangedLines = $state<number | undefined>(
		DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.filters.maxChangedLines ?? undefined,
	);
	debounceMinutes = $state<number | undefined>(
		DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.debounceMinutes,
	);
	maxAttemptsPerCommit = $state<number | undefined>(
		DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.maxAttemptsPerCommit,
	);
	dailyReviewLimit = $state<number | undefined>(
		DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.dailyReviewLimit,
	);
	#savedTarget = $state<PullRequestReviewRepositoryInput['target'] | null>(null);
	#savedDraft = '';
	#startupLoad: Promise<void> | null = null;
	#disposed = false;
	saving = $state(false);
	promptTransformPending = $state(false);
	error = $state<string | null>(null);

	constructor(private readonly options: PullRequestRepositoryFormOptions) {
		this.startup = new NewChatFormState({
			modelCatalog: options.modelCatalog,
			executors: options.executors,
			remoteSettings: options.remoteSettings,
			get selectableAgentIds() {
				return options.selectableAgentIds;
			},
		});
	}

	get promptError(): string | null {
		if (this.prompt.length > PULL_REQUEST_REVIEW_PROMPT_MAX_LENGTH)
			return m.pull_request_repository_prompt_too_long();
		return null;
	}

	get canSave(): boolean {
		return (
			!this.saving &&
			!this.promptTransformPending &&
			this.promptError === null &&
			this.#settings() !== null &&
			(this.settingsOnlyOffline ||
				(this.startup.settingsLoaded &&
					this.startup.executorReady &&
					this.options.selectableAgentIds.includes(this.startup.agentId) &&
					this.startup.validationStatus === 'valid' &&
					this.startup.resolvedModelSelection !== null))
		);
	}

	get settingsError(): string | null {
		return this.#settings() ? null : m.pull_request_repository_settings_invalid();
	}

	#settings(): PullRequestReviewSettings | null {
		return normalizePullRequestReviewSettings({
			autoReview: this.autoReview,
			onlyWhenReviewRequested: this.onlyWhenReviewRequested,
			filters: {
				...this.filters,
				baseBranches: filterLines(this.baseBranches),
				includeLabels: filterLines(this.includeLabels),
				excludeLabels: filterLines(this.excludeLabels),
				maxChangedLines: this.maxChangedLines ?? null,
			},
			debounceMinutes: this.debounceMinutes,
			maxAttemptsPerCommit: this.maxAttemptsPerCommit,
			dailyReviewLimit: this.dailyReviewLimit,
			autoPost: this.autoPost,
			// The built-in prompt is stored as empty so it follows later improvements.
			prompt: this.prompt.trim() === DEFAULT_PULL_REQUEST_REVIEW_PROMPT ? '' : this.prompt,
		});
	}

	get settingsOnlyOffline(): boolean {
		return (
			this.#savedTarget !== null &&
			!this.startup.executorReady &&
			this.#savedDraft === this.#startupDraft()
		);
	}

	#startupDraft(): string {
		return JSON.stringify([
			this.startup.executorId,
			this.startup.agentId,
			this.startup.nonblankPath,
			this.startup.modelValue,
			this.startup.modelSelectionTarget,
			this.startup.permissionMode,
			this.startup.thinkingMode,
			this.startup.agentSettingsById,
			this.startup.chatTags,
			this.startup.preambles.choiceSnapshot,
		]);
	}

	async initialize(repository: PullRequestReviewRepository | null): Promise<void> {
		if (!repository) {
			// A new repository starts from the new-chat defaults, permission mode included.
			await this.#loadStartup();
			return;
		}
		const { target, settings } = repository;
		this.repositoryId = repository.id;
		this.prompt = settings.prompt || DEFAULT_PULL_REQUEST_REVIEW_PROMPT;
		this.autoReview = settings.autoReview;
		this.autoPost = settings.autoPost;
		this.onlyWhenReviewRequested = settings.onlyWhenReviewRequested;
		this.filters = {
			skipDrafts: settings.filters.skipDrafts,
			trustedAuthorsOnly: settings.filters.trustedAuthorsOnly,
		};
		this.baseBranches = settings.filters.baseBranches.join('\n');
		this.includeLabels = settings.filters.includeLabels.join('\n');
		this.excludeLabels = settings.filters.excludeLabels.join('\n');
		this.maxChangedLines = settings.filters.maxChangedLines ?? undefined;
		this.debounceMinutes = settings.debounceMinutes;
		this.maxAttemptsPerCommit = settings.maxAttemptsPerCommit;
		this.dailyReviewLimit = settings.dailyReviewLimit;
		this.startup.selectExecutor(target.executorId);
		this.startup.restoreSelection(target.agentId, {
			model: target.model,
			apiProviderId: target.apiProviderId,
			modelEndpointId: target.modelEndpointId,
			modelProtocol: target.modelProtocol,
		});
		this.startup.projectPath = target.projectPath;
		this.startup.restoreExecutionModes(target.permissionMode, target.thinkingMode);
		this.startup.replaceAgentSettingsById(target.agentSettingsById);
		this.startup.chatTags = [...target.tags];
		this.startup.showTagInput = false;
		this.startup.preambles.restoreChoice(target.preambleChoice);
		this.#savedTarget = target;
		this.#savedDraft = this.#startupDraft();
		await this.loadStartupWhenReady();
	}

	loadStartupWhenReady(): Promise<void> {
		if (this.#disposed || !this.startup.executorReady || this.startup.settingsLoaded)
			return Promise.resolve();
		return this.#loadStartup();
	}

	#loadStartup(): Promise<void> {
		this.#startupLoad ??= this.startup
			.loadSettingsAndModels()
			.then(() => {
				if (!this.#disposed) this.startup.validatePath();
			})
			.finally(() => {
				this.#startupLoad = null;
			});
		return this.#startupLoad;
	}

	buildInput(): PullRequestReviewRepositoryInput | null {
		const selection = this.startup.resolvedModelSelection;
		const settings = this.#settings();
		if (!this.canSave || !settings || (!this.settingsOnlyOffline && !selection)) return null;
		return {
			target: this.settingsOnlyOffline
				? this.#savedTarget!
				: {
						type: 'new-chat',
						...(this.startup.executorId === 'local' ? {} : { executorId: this.startup.executorId }),
						agentId: this.startup.agentId,
						projectPath: this.startup.nonblankPath,
						model: selection!.model,
						apiProviderId: selection!.apiProviderId,
						modelEndpointId: selection!.modelEndpointId,
						modelProtocol: selection!.modelProtocol,
						permissionMode: this.startup.permissionMode,
						thinkingMode: this.startup.thinkingMode,
						agentSettingsById: this.startup.agentSettingsById,
						tags: [...this.startup.chatTags],
						preambleChoice: this.startup.preambles.choiceSnapshot,
					},
			settings,
		};
	}

	dispose(): void {
		this.#disposed = true;
		this.startup.dispose();
	}
}

function filterLines(value: string): string[] {
	return value
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
}
