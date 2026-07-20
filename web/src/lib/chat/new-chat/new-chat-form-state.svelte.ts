// Reactive state management for the new-chat form. Encapsulates agent,
// model, permission/thinking mode, path validation, image attachments, and
// the config payload used to start a session.

import { browseDirectory } from '$lib/api/files.js';
import { validateStart, type ValidateStartErrorCode } from '$lib/api/chats.js';
import { ImageAttachmentState } from '$lib/chat/composer/image-attachment.svelte.js';
import { getGitWorktrees, gitCreateWorktree } from '$lib/api/git.js';
import type { GitWorktreeItem } from '$lib/api/git.js';
import type { NewChatConfig, SessionAgentId } from '$lib/types/app.js';
import type { PermissionMode, ThinkingMode } from '$lib/types/chat.js';
import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
import type { JsonValue } from '$shared/json';
import { DEFAULT_AGENT_ID } from '$shared/agents';
import type {
	ExecutionDefaults,
	RecentAgentSetting,
	RemoteExecutionDefaults,
	RemoteSettingsSnapshot,
} from '$shared/settings';
import {
	cloneAgentSettings,
	normalizeAgentSettings,
	withAgentSetting,
} from '$lib/agents/agent-settings.js';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import {
	normalizeSupportedPermissionMode,
	normalizeSupportedThinkingMode,
} from '$lib/agents/agent-modes.js';
import { canSubmitNewChat, type PathValidationStatus } from '$lib/chat/new-chat/new-chat-submit.js';
import {
	isPinnedProjectPath,
	nextPinnedProjectPaths,
} from '$lib/chat/project-paths/project-pinned-paths.js';
import { savePinnedProjectPathsOptimistically } from '$lib/chat/project-paths/pinned-project-path-settings.js';
import { normalizeTagSlug } from '$lib/utils/tags.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import * as m from '$lib/paraglide/messages.js';

export class NewChatFormState {
	// Agent and model
	agentId = $state<SessionAgentId>(DEFAULT_AGENT_ID);
	selectedModelsByAgent = $state<Record<string, string>>({});

	// Path
	projectPath = $state('');
	pinnedProjectPaths = $state<string[]>([]);
	browseStartPath = $state('');
	projectBasePath = $state('/');

	// Path validation
	validationStatus = $state<PathValidationStatus>('idle');
	validationError = $state<string | null>(null);
	#validationTimer: ReturnType<typeof setTimeout> | null = null;
	#validationRequestVersion = 0;
	#worktreeRequestVersion = 0;
	#worktreeAbort: AbortController | null = null;

	// Modes
	permissionMode = $state<PermissionMode>('default');
	thinkingMode = $state<ThinkingMode>('none');
	agentSettingsById = $state<Record<string, AgentSettingsEnvelope>>({});
	readonly #configuredAgentSettings = new Set<string>();
	#modesTouched = false;
	#executionDefaults: RemoteExecutionDefaults | null = null;
	#startupRecents: RecentAgentSetting[] = [];
	#awaitingCatalogStartupSelection = false;

	// Tags
	chatTags = $state<string[]>([]);
	showTagInput = $state(false);

	// Form
	firstMessage = $state('');
	error = $state<string | null>(null);
	showBrowser = $state(false);
	hasAutoOpened = $state(false);
	settingsLoaded = $state(false);
	isUpdatingPinnedPath = $state(false);

	// Git repo status from validate-start endpoint.
	gitRepoStatus = $state<'unknown' | 'git' | 'non-git'>('unknown');

	// Worktree modal
	worktreeModalOpen = $state(false);
	worktreeItems = $state<GitWorktreeItem[]>([]);
	isLoadingWorktrees = $state(false);
	isCreatingWorktree = $state(false);
	worktreeError = $state<string | null>(null);
	// Images (delegated to shared ImageAttachmentState)
	readonly #images = new ImageAttachmentState();

	// Injected dependencies
	readonly #modelCatalog: ModelCatalogStore;
	readonly #remoteSettings: RemoteSettingsStore;

	constructor(modelCatalog: ModelCatalogStore, remoteSettings: RemoteSettingsStore) {
		this.#modelCatalog = modelCatalog;
		this.#remoteSettings = remoteSettings;
	}

	// Derived accessors

	get trimmedPath(): string {
		return this.projectPath.trim();
	}

	get isPinnedPath(): boolean {
		return isPinnedProjectPath(this.pinnedProjectPaths, this.trimmedPath);
	}

	get permissionModes(): PermissionMode[] {
		return [...this.#modelCatalog.getPermissionModes(this.agentId)];
	}

	get thinkingModes(): ThinkingMode[] {
		return [...this.#modelCatalog.getThinkingModes(this.agentId)];
	}

	get canSubmit(): boolean {
		return (
			this.settingsLoaded &&
			canSubmitNewChat(
				this.trimmedPath,
				this.validationStatus,
				this.firstMessage,
				this.attachedImages.length,
			)
		);
	}

	get placeholder(): string {
		return m.chat_new_chat_placeholder();
	}

	get modelValue(): string {
		return (
			this.selectedModelsByAgent[this.agentId] ?? this.#modelCatalog.getDefaultModel(this.agentId)
		);
	}

	get agentSettings(): AgentSettingsEnvelope {
		return normalizeAgentSettings(
			this.agentId,
			this.agentSettingsById[this.agentId],
			this.#modelCatalog.getDefaultAgentSettings(this.agentId),
		);
	}

	get agentSettingDescriptors(): readonly AgentSettingDescriptor[] {
		return this.#modelCatalog.getAgentSettingsDescriptors(this.agentId);
	}

	// Agent selection

	selectAgent(next: SessionAgentId): void {
		this.#awaitingCatalogStartupSelection = false;
		const changed = this.agentId !== next;
		this.agentId = next;
		if (changed && !this.#modesTouched) {
			this.#applyExecutionDefaultsForAgent(next);
		} else if (changed) {
			this.permissionMode = normalizeSupportedPermissionMode(
				this.permissionMode,
				this.#modelCatalog.getPermissionModes(next),
			);
			this.thinkingMode = normalizeSupportedThinkingMode(
				this.thinkingMode,
				this.#modelCatalog.getThinkingModes(next),
			);
		}
		this.#ensureAgentSettings(next);
	}

	setPermissionMode(mode: PermissionMode): void {
		this.permissionMode = normalizeSupportedPermissionMode(mode, this.permissionModes);
		this.#modesTouched = true;
	}

	setThinkingMode(mode: ThinkingMode): void {
		this.thinkingMode = normalizeSupportedThinkingMode(mode, this.thinkingModes);
		this.#modesTouched = true;
	}

	setAgentSetting(descriptor: AgentSettingDescriptor, value: JsonValue): void {
		this.#configuredAgentSettings.add(this.agentId);
		this.agentSettingsById = {
			...this.agentSettingsById,
			[this.agentId]: withAgentSetting(this.agentSettings, descriptor, value),
		};
	}

	replaceAgentSettingsById(settingsById: Record<string, AgentSettingsEnvelope>): void {
		const next: Record<string, AgentSettingsEnvelope> = {};
		this.#configuredAgentSettings.clear();
		for (const [agentId, settings] of Object.entries(settingsById)) {
			if (settings.ownerId !== agentId) continue;
			next[agentId] = cloneAgentSettings(settings);
			this.#configuredAgentSettings.add(agentId);
		}
		for (const agentId of this.#modelCatalog.getSelectableAgents()) {
			next[agentId] = normalizeAgentSettings(
				agentId,
				next[agentId],
				this.#modelCatalog.getDefaultAgentSettings(agentId),
			);
		}
		this.agentSettingsById = next;
	}

	// Model

	handleModelChange(value: string): void {
		this.selectedModelsByAgent = {
			...this.selectedModelsByAgent,
			[this.agentId]: value,
		};
	}

	/** Validates the selected model against the live model list for an agent. */
	validateModelAgainstLive(agentId: SessionAgentId): void {
		const liveModels = this.#modelCatalog.getModels(agentId);
		if (!liveModels?.length) return;
		const current = this.selectedModelsByAgent[agentId];
		if (!current || !liveModels.some((entry) => entry.value === current)) {
			this.selectedModelsByAgent = {
				...this.selectedModelsByAgent,
				[agentId]: liveModels[0].value,
			};
		}
	}

	validateAllModelsAgainstLive(): void {
		for (const agentId of this.#modelCatalog.getSelectableAgents()) {
			this.validateModelAgainstLive(agentId);
		}
	}

	#resolveStartupAgent(agentId: string): SessionAgentId {
		const agents = this.#modelCatalog.getSelectableAgents();
		if (agents.includes(agentId as SessionAgentId)) return agentId as SessionAgentId;
		if (agents.includes(DEFAULT_AGENT_ID)) return DEFAULT_AGENT_ID;
		return agents[0] ?? DEFAULT_AGENT_ID;
	}

	applyResolvedModel(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId?: string | null,
	): void {
		const liveModels = this.#modelCatalog.getModels(agentId);
		const selectionValue = this.#modelCatalog.selectionValueFor(agentId, model, modelEndpointId);
		const resolvedModel = liveModels.some((entry) => entry.value === selectionValue)
			? selectionValue
			: (liveModels[0]?.value ?? model);
		this.selectedModelsByAgent = {
			...this.selectedModelsByAgent,
			[agentId]: resolvedModel,
		};
	}

	// Images (delegated to ImageAttachmentState)

	get attachedImages(): File[] {
		return this.#images.images;
	}

	set attachedImages(files: File[]) {
		this.#images.images = files;
	}

	imageUrlFor(file: File, idx: number): string | undefined {
		return this.#images.urlFor(file, idx);
	}

	addImages(files: File[]): void {
		this.#images.add(files);
	}

	removeImage(index: number): void {
		this.#images.remove(index);
	}

	reconcileImageUrls(): void {
		this.#images.syncUrls();
	}

	revokeAllImageUrls(): void {
		this.#images.revokeAll();
	}

	// Worktree modal

	openWorktreeModal(): void {
		this.worktreeModalOpen = true;
		this.worktreeError = null;
		this.worktreeItems = [];
		void this.loadWorktrees();
	}

	closeWorktreeModal(): void {
		this.worktreeModalOpen = false;
		this.worktreeError = null;
		this.#cancelWorktreeLoad();
	}

	async loadWorktrees(): Promise<void> {
		const projectPath = this.trimmedPath;
		if (!projectPath) return;

		this.#worktreeAbort?.abort();
		const abort = new AbortController();
		this.#worktreeAbort = abort;
		const requestVersion = ++this.#worktreeRequestVersion;
		this.isLoadingWorktrees = true;
		this.worktreeError = null;

		try {
			const result = await getGitWorktrees(projectPath, { signal: abort.signal });
			if (!this.#isCurrentWorktreeLoad(requestVersion, abort.signal)) return;
			this.worktreeItems = result.worktrees;
		} catch (error) {
			if (isAbortError(error) || !this.#isCurrentWorktreeLoad(requestVersion, abort.signal)) {
				return;
			}
			this.worktreeError = m.git_target_load_worktrees_failed();
			this.worktreeItems = [];
		} finally {
			if (this.#isCurrentWorktreeLoad(requestVersion, abort.signal)) {
				this.#worktreeAbort = null;
				this.isLoadingWorktrees = false;
			}
		}
	}

	#cancelWorktreeLoad(): void {
		this.#worktreeAbort?.abort();
		this.#worktreeAbort = null;
		this.#worktreeRequestVersion += 1;
		this.isLoadingWorktrees = false;
	}

	#isCurrentWorktreeLoad(requestVersion: number, signal: AbortSignal): boolean {
		return !signal.aborted && requestVersion === this.#worktreeRequestVersion;
	}

	selectWorktree(worktreePath: string): void {
		this.#cancelWorktreeLoad();
		this.projectPath = worktreePath;
		this.worktreeModalOpen = false;
		this.clearError();
	}

	async createWorktree(worktreePath: string, branch?: string, baseRef?: string): Promise<boolean> {
		if (!this.trimmedPath) return false;
		this.isCreatingWorktree = true;
		this.worktreeError = null;

		try {
			const result = await gitCreateWorktree(this.trimmedPath, worktreePath, { branch, baseRef });
			if (!result.success) {
				this.worktreeError =
					result.error || result.message || m.chat_new_chat_create_worktree_failed();
				return false;
			}
			await this.loadWorktrees();
			this.selectWorktree(result.worktreePath || worktreePath);
			return true;
		} catch (err) {
			this.worktreeError =
				err instanceof Error ? err.message : m.chat_new_chat_create_worktree_failed();
			return false;
		} finally {
			this.isCreatingWorktree = false;
		}
	}

	// Path validation

	/** Debounced validation of the project path against the server. */
	validatePath(): void {
		const path = this.trimmedPath;
		if (!path) {
			this.#clearValidation();
			return;
		}

		this.validationStatus = 'checking';
		this.validationError = null;

		if (this.#validationTimer) clearTimeout(this.#validationTimer);
		const requestVersion = ++this.#validationRequestVersion;

		this.#validationTimer = setTimeout(async () => {
			try {
				const data = await validateStart(path);
				if (requestVersion !== this.#validationRequestVersion) return;
				if (data.valid) {
					this.validationStatus = 'valid';
					this.validationError = null;
					this.gitRepoStatus = data.isGitRepo ? 'git' : 'non-git';
				} else {
					this.validationStatus = 'invalid';
					this.validationError = this.#validationErrorMessage(data.errorCode);
					this.gitRepoStatus = 'non-git';
				}
			} catch (err) {
				if (requestVersion !== this.#validationRequestVersion) return;
				this.validationStatus = 'invalid';
				this.validationError = m.chat_new_chat_errors_invalid_directory();
				this.gitRepoStatus = 'non-git';
				console.warn('[NewChatFormState] Path validation request failed', err);
			}
		}, 300);
	}

	#validationErrorMessage(errorCode?: ValidateStartErrorCode): string {
		if (errorCode === 'outside_base_dir') return m.chat_new_chat_errors_path_outside_base_dir();
		if (errorCode === 'path_not_found') return m.chat_new_chat_errors_path_not_found();
		if (errorCode === 'permission_denied') return m.chat_new_chat_errors_path_permission_denied();
		if (errorCode === 'not_directory') return m.chat_new_chat_errors_path_not_directory();
		return m.chat_new_chat_errors_invalid_directory();
	}

	#clearValidation(): void {
		if (this.#validationTimer) {
			clearTimeout(this.#validationTimer);
			this.#validationTimer = null;
		}
		this.#validationRequestVersion += 1;
		this.validationStatus = 'idle';
		this.validationError = null;
		this.gitRepoStatus = 'unknown';
	}

	// Pinned paths

	async togglePinnedPath(): Promise<void> {
		const path = this.trimmedPath;
		if (!path || this.isUpdatingPinnedPath) return;
		const previous = this.pinnedProjectPaths;
		const next = nextPinnedProjectPaths(this.pinnedProjectPaths, path);
		this.pinnedProjectPaths = next;
		this.isUpdatingPinnedPath = true;
		try {
			const snap = await savePinnedProjectPathsOptimistically(this.#remoteSettings, next, {
				browseStartPath: this.browseStartPath || path,
			});
			this.pinnedProjectPaths = snap.paths.pinnedProjectPaths;
			this.browseStartPath = snap.paths.browseStartPath;
		} catch (err) {
			this.pinnedProjectPaths = previous;
			console.warn('[NewChatFormState] Failed to persist pinned project paths', err);
		} finally {
			this.isUpdatingPinnedPath = false;
		}
	}

	// Tags

	toggleTagInput(): void {
		this.showTagInput = !this.showTagInput;
	}

	addTag(raw: string): boolean {
		const normalized = normalizeTagSlug(raw);
		if (!normalized) return false;
		if (this.chatTags.some((t) => t.toLowerCase() === normalized)) return false;
		this.chatTags = [...this.chatTags, normalized];
		return true;
	}

	removeTag(tag: string): void {
		this.chatTags = this.chatTags.filter((t) => t !== tag);
	}

	// Form submission

	clearError(): void {
		if (this.error) this.error = null;
	}

	/** Validates and builds the config, returning null if validation fails. */
	buildConfig(): NewChatConfig | null {
		if (!this.settingsLoaded) {
			this.error = m.chat_new_chat_errors_defaults_loading();
			return null;
		}
		if (!this.trimmedPath) {
			this.error = m.chat_new_chat_errors_project_path_required();
			return null;
		}
		if (this.validationStatus === 'checking') {
			this.error = m.chat_new_chat_errors_invalid_directory();
			return null;
		}
		if (this.validationStatus === 'invalid' || this.validationStatus === 'idle') {
			this.error = this.validationError || m.chat_new_chat_errors_invalid_directory();
			return null;
		}
		if (!this.firstMessage.trim() && this.attachedImages.length === 0) {
			this.error = m.chat_messages_send_first_message();
			return null;
		}
		this.error = null;
		const selection = this.#modelCatalog.selectionFor(this.agentId, this.modelValue);

		return {
			agentId: this.agentId,
			projectPath: this.trimmedPath,
			model: selection.model,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
			permissionMode: normalizeSupportedPermissionMode(this.permissionMode, this.permissionModes),
			thinkingMode: normalizeSupportedThinkingMode(this.thinkingMode, this.thinkingModes),
			agentSettings: this.agentSettings,
			firstMessage: this.firstMessage.trim(),
			initialImages: this.attachedImages,
			tags: this.chatTags.length > 0 ? this.chatTags : undefined,
		};
	}

	// Reseed / reset

	/** Resets form state when the dialog opens. */
	reseed(prefill: string): void {
		this.firstMessage = prefill;
		this.attachedImages = [];
		this.error = null;
		this.showBrowser = false;
		this.hasAutoOpened = false;
		this.gitRepoStatus = 'unknown';
		this.worktreeModalOpen = false;
		this.worktreeItems = [];
		this.worktreeError = null;
		this.chatTags = [];
		this.showTagInput = false;
		this.#modesTouched = false;
	}

	// Initialization

	/** Loads server settings without blocking the form on live model discovery. */
	async loadSettingsAndModels(): Promise<void> {
		this.#awaitingCatalogStartupSelection = this.#modelCatalog.getSelectableAgents().length === 0;
		try {
			const settingsData = await this.#remoteSettings.ensureLoaded();
			this.#applySettings(settingsData);
			this.validateAllModelsAgainstLive();
		} catch (err) {
			console.warn('[NewChatFormState] Failed to load settings', err);
			for (const agentId of this.#modelCatalog.getSelectableAgents()) {
				this.applyResolvedModel(agentId, this.#modelCatalog.getDefaultModel(agentId));
			}
			if (!this.projectPath) {
				this.projectPath = this.projectBasePath;
			}
		} finally {
			this.settingsLoaded = true;
			void this.#refreshModelsInBackground();
		}
	}

	async #refreshModelsInBackground(): Promise<void> {
		try {
			await this.#modelCatalog.refreshIfStale();
			this.#reconcileAgentSettingsWithCatalog();
			if (this.#awaitingCatalogStartupSelection) {
				const recent = this.#firstSelectableRecent(this.#startupRecents);
				this.agentId = recent
					? (recent.agentId as SessionAgentId)
					: this.#resolveStartupAgent(DEFAULT_AGENT_ID);
				if (recent) {
					this.applyResolvedModel(this.agentId, recent.model, recent.modelEndpointId);
				}
				this.#applyExecutionDefaultsForAgent(this.agentId);
				this.#awaitingCatalogStartupSelection = false;
			}
			this.validateAllModelsAgainstLive();
		} catch (err) {
			console.warn('[NewChatFormState] Failed to refresh models', err);
		}
	}

	#applySettings(snap: RemoteSettingsSnapshot): void {
		this.projectBasePath = snap.projectBasePath;
		this.#executionDefaults = snap.executionDefaults;
		this.#startupRecents = snap.recentAgentSettings;
		this.#seedAgentSettings(snap.executionDefaults);

		this.pinnedProjectPaths = snap.paths.pinnedProjectPaths ?? [];
		this.browseStartPath = snap.paths.browseStartPath ?? '';

		const defaultPath = snap.paths.recentProjectPaths[0] || this.browseStartPath;
		if (defaultPath && !this.projectPath) {
			this.projectPath = defaultPath;
		}

		if (!this.projectPath) {
			this.projectPath = this.projectBasePath;
		}

		const recent = this.#firstSelectableRecent(snap.recentAgentSettings);
		if (recent) {
			this.agentId = recent.agentId as SessionAgentId;
			this.applyResolvedModel(this.agentId, recent.model, recent.modelEndpointId);
			this.#applyExecutionDefaultsForAgent(this.agentId);
			return;
		}

		this.agentId = this.#resolveStartupAgent(DEFAULT_AGENT_ID);
		for (const agentId of this.#modelCatalog.getSelectableAgents()) {
			this.applyResolvedModel(agentId, this.#modelCatalog.getDefaultModel(agentId));
		}
		this.#applyExecutionDefaultsForAgent(this.agentId);
	}

	#firstSelectableRecent(recents: RecentAgentSetting[]): RecentAgentSetting | null {
		const selectable = new Set(this.#modelCatalog.getSelectableAgents());
		for (const recent of recents) {
			const agentId = recent.agentId as SessionAgentId;
			if (!selectable.has(agentId)) continue;
			const modelValue = this.#modelCatalog.selectionValueFor(
				agentId,
				recent.model,
				recent.modelEndpointId,
			);
			if (!modelValue) continue;
			const model = this.#modelCatalog.getModelForSelection(
				agentId,
				modelValue,
				recent.modelEndpointId,
			);
			if (model) return recent;
		}
		return null;
	}

	#executionDefaultsForAgent(agentId: SessionAgentId): ExecutionDefaults {
		const defaults = this.#executionDefaults;
		if (!defaults) {
			return {
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettingsById: {},
			};
		}
		const override = defaults.byAgent[agentId];
		return {
			permissionMode: override?.permissionMode ?? defaults.global.permissionMode,
			thinkingMode: override?.thinkingMode ?? defaults.global.thinkingMode,
			agentSettingsById: {
				...defaults.global.agentSettingsById,
				...(override?.agentSettingsById ?? {}),
			},
		};
	}

	#applyExecutionDefaultsForAgent(agentId: SessionAgentId): void {
		const modes = this.#executionDefaultsForAgent(agentId);
		this.permissionMode = normalizeSupportedPermissionMode(
			modes.permissionMode,
			this.#modelCatalog.getPermissionModes(agentId),
		);
		this.thinkingMode = normalizeSupportedThinkingMode(
			modes.thinkingMode,
			this.#modelCatalog.getThinkingModes(agentId),
		);
		this.#ensureAgentSettings(agentId, modes.agentSettingsById[agentId]);
	}

	#seedAgentSettings(defaults: RemoteExecutionDefaults): void {
		const next: Record<string, AgentSettingsEnvelope> = {};
		for (const [agentId, settings] of Object.entries(defaults.global.agentSettingsById)) {
			if (settings.ownerId !== agentId) continue;
			next[agentId] = cloneAgentSettings(settings);
			this.#configuredAgentSettings.add(agentId);
		}
		for (const agentId of this.#modelCatalog.getSelectableAgents()) {
			const agentDefaults = defaults.byAgent[agentId];
			const configured =
				agentDefaults?.agentSettingsById?.[agentId] ?? defaults.global.agentSettingsById[agentId];
			if (configured) this.#configuredAgentSettings.add(agentId);
			next[agentId] = normalizeAgentSettings(
				agentId,
				configured ?? next[agentId],
				this.#modelCatalog.getDefaultAgentSettings(agentId),
			);
		}
		this.agentSettingsById = next;
	}

	#ensureAgentSettings(agentId: SessionAgentId, configured?: AgentSettingsEnvelope): void {
		if (configured) this.#configuredAgentSettings.add(agentId);
		const current = configured ?? this.agentSettingsById[agentId];
		this.agentSettingsById = {
			...this.agentSettingsById,
			[agentId]: normalizeAgentSettings(
				agentId,
				current,
				this.#modelCatalog.getDefaultAgentSettings(agentId),
			),
		};
	}

	#reconcileAgentSettingsWithCatalog(): void {
		const next = { ...this.agentSettingsById };
		for (const agentId of this.#modelCatalog.getSelectableAgents()) {
			if (this.#configuredAgentSettings.has(agentId)) continue;
			next[agentId] = normalizeAgentSettings(
				agentId,
				this.#modelCatalog.getDefaultAgentSettings(agentId),
				this.#modelCatalog.getDefaultAgentSettings(agentId),
			);
		}
		this.agentSettingsById = next;
	}

	// Auto-open browser on first path focus

	handlePathFocus(): void {
		this.showBrowser = true;
	}

	// Tab-completion for the path input

	tabCompletions = $state<string[]>([]);
	#tabCompletionIndex = 0;

	/** Handles Tab key in the path input. Completes the path like a terminal. */
	async handleTabCompletion(): Promise<void> {
		const raw = this.projectPath;
		if (!raw) return;

		// If we already have multiple completions, cycle through them.
		if (this.tabCompletions.length > 1) {
			this.#tabCompletionIndex = (this.#tabCompletionIndex + 1) % this.tabCompletions.length;
			this.projectPath = this.tabCompletions[this.#tabCompletionIndex];
			return;
		}

		// Determine the parent directory and partial name to match.
		const lastSlash = raw.lastIndexOf('/');
		const parentDir = lastSlash >= 0 ? raw.slice(0, lastSlash) || '/' : '/';
		const partial = lastSlash >= 0 ? raw.slice(lastSlash + 1).toLowerCase() : '';

		try {
			const entries = await browseDirectory(parentDir);
			const matches = partial
				? entries.filter((e) => e.name.toLowerCase().startsWith(partial))
				: entries;

			if (matches.length === 0) return;

			const matchPaths = matches.map((e) => e.path);

			if (matches.length === 1) {
				// Single match — complete it and add trailing slash.
				this.projectPath = matchPaths[0] + '/';
				this.tabCompletions = [];
			} else {
				// Multiple matches — fill common prefix and open browser.
				const common = longestCommonPrefix(matchPaths);
				if (common.length > raw.length) {
					this.projectPath = common;
				}
				this.tabCompletions = matchPaths;
				this.#tabCompletionIndex = 0;
				this.showBrowser = true;
			}
		} catch {
			// Silently ignore browse errors on tab.
		}
	}

	/** Resets tab-completion state when the user types. */
	resetTabCompletions(): void {
		this.tabCompletions = [];
		this.#tabCompletionIndex = 0;
	}
}

function longestCommonPrefix(strings: string[]): string {
	if (strings.length === 0) return '';
	let prefix = strings[0];
	for (let i = 1; i < strings.length; i++) {
		while (!strings[i].startsWith(prefix)) {
			prefix = prefix.slice(0, -1);
			if (!prefix) return '';
		}
	}
	return prefix;
}
