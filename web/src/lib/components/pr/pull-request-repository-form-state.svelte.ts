import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte.js';
import {
	DEFAULT_PULL_REQUEST_REVIEW_PROMPT,
	DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
	PULL_REQUEST_REVIEW_PROMPT_MAX_LENGTH,
	type PullRequestReviewPostingMode,
	type PullRequestReviewRepository,
	type PullRequestReviewRepositoryInput,
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
	posting = $state<PullRequestReviewPostingMode>(DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.posting);
	onlyWhenReviewRequested = $state(DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.onlyWhenReviewRequested);
	filters = $state({ ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.filters });
	debounceMinutes = $state(DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.debounceMinutes);
	#retained = { ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS };
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
		if (this.prompt.length > PULL_REQUEST_REVIEW_PROMPT_MAX_LENGTH) return m.pull_request_repository_prompt_too_long();
		return null;
	}

	get canSave(): boolean {
		return (
			!this.saving &&
			!this.promptTransformPending &&
			this.promptError === null &&
			this.startup.settingsLoaded &&
			this.startup.executorReady &&
			this.options.selectableAgentIds.includes(this.startup.agentId) &&
			this.startup.validationStatus === 'valid' &&
			this.startup.resolvedModelSelection !== null
		);
	}

	async initialize(repository: PullRequestReviewRepository | null): Promise<void> {
		if (!repository) {
			// A new repository starts from the new-chat defaults, permission mode included.
			await this.startup.loadSettingsAndModels();
			return;
		}
		const { target, settings } = repository;
		this.repositoryId = repository.id;
		this.#retained = settings;
		this.prompt = settings.prompt || DEFAULT_PULL_REQUEST_REVIEW_PROMPT;
		this.autoReview = settings.autoReview;
		this.posting = settings.posting;
		this.onlyWhenReviewRequested = settings.onlyWhenReviewRequested;
		this.filters = { ...settings.filters };
		this.debounceMinutes = settings.debounceMinutes;
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
		await this.startup.loadSettingsAndModels();
		this.startup.validatePath();
	}

	buildInput(): PullRequestReviewRepositoryInput | null {
		const selection = this.startup.resolvedModelSelection;
		if (!this.canSave || !selection) return null;
		return {
			target: {
				type: 'new-chat',
				...(this.startup.executorId === 'local' ? {} : { executorId: this.startup.executorId }),
				agentId: this.startup.agentId,
				projectPath: this.startup.nonblankPath,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
				permissionMode: this.startup.permissionMode,
				thinkingMode: this.startup.thinkingMode,
				agentSettingsById: this.startup.agentSettingsById,
				tags: [...this.startup.chatTags],
				preambleChoice: this.startup.preambles.choiceSnapshot,
			},
			settings: {
				...this.#retained,
				autoReview: this.autoReview,
				onlyWhenReviewRequested: this.onlyWhenReviewRequested,
				filters: { ...this.filters },
				debounceMinutes: this.debounceMinutes,
				posting: this.posting,
				// The built-in prompt is stored as empty so it follows later improvements.
				prompt: this.prompt.trim() === DEFAULT_PULL_REQUEST_REVIEW_PROMPT ? '' : this.prompt,
			},
		};
	}

	dispose(): void {
		this.startup.dispose();
	}
}
