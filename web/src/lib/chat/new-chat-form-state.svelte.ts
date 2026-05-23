// Reactive state management for the new-chat form. Encapsulates agent,
// model, permission/thinking mode, path validation, image attachments, and
// the config payload used to start a session.

import { browseDirectory } from '$lib/api/files.js';
import { validateStart, type ValidateStartErrorCode } from '$lib/api/chats.js';
import { ImageAttachmentState } from '$lib/chat/image-attachment.svelte.js';
import { getGitWorktrees, gitCreateWorktree } from '$lib/api/git.js';
import type { GitWorktreeItem } from '$lib/api/git.js';
import type { NewChatConfig, SessionAgentId } from '$lib/types/app.js';
import type { AmpAgentMode, ClaudeThinkingMode, PermissionMode, ThinkingMode } from '$lib/types/chat.js';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import {
	normalizeAmpAgentMode,
	normalizeClaudeThinkingMode,
	normalizePermissionMode,
	normalizeThinkingMode,
} from '$shared/chat-modes';
import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte.js';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import { CLAUDE_PERMISSION_MODES, NON_CLAUDE_PERMISSION_MODES } from '$lib/chat/chat-ui-constants.js';
import { canSubmitNewChat, type PathValidationStatus } from '$lib/components/chat/new-chat-submit.js';
import { normalizeTagSlug } from '$lib/utils/tags.js';
import * as m from '$lib/paraglide/messages.js';

export class NewChatFormState {
	// Agent and model
	agentId = $state<SessionAgentId>('claude');
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

	// Modes
	permissionMode = $state<PermissionMode>('default');
	thinkingMode = $state<ThinkingMode>('none');
	claudeThinkingMode = $state<ClaudeThinkingMode>('auto');
	ampAgentMode = $state<AmpAgentMode>('smart');

	// Tags
	chatTags = $state<string[]>([]);
	showTagInput = $state(false);

	// Form
	firstMessage = $state('');
	error = $state<string | null>(null);
	showBrowser = $state(false);
	hasAutoOpened = $state(false);
	settingsLoaded = $state(false);

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
	readonly #appShell: AppShellStore;
	readonly #modelCatalog: ModelCatalogStore;
	readonly #remoteSettings: RemoteSettingsStore;

	constructor(appShell: AppShellStore, modelCatalog: ModelCatalogStore, remoteSettings: RemoteSettingsStore) {
		this.#appShell = appShell;
		this.#modelCatalog = modelCatalog;
		this.#remoteSettings = remoteSettings;
	}

	// Derived accessors

	get trimmedPath(): string {
		return this.projectPath.trim();
	}

	get isPinnedPath(): boolean {
		return Boolean(this.trimmedPath) && this.pinnedProjectPaths.includes(this.trimmedPath);
	}

	get permissionModes(): PermissionMode[] {
		return this.agentId === 'claude' ? CLAUDE_PERMISSION_MODES : NON_CLAUDE_PERMISSION_MODES;
	}

	get canSubmit(): boolean {
		return this.settingsLoaded && canSubmitNewChat(this.trimmedPath, this.validationStatus, this.firstMessage);
	}

	get placeholder(): string {
		return m.chat_new_chat_placeholder();
	}

	get modelValue(): string {
		return this.selectedModelsByAgent[this.agentId] ?? this.#modelCatalog.getDefaultModel(this.agentId);
	}

	// Agent selection

	selectAgent(next: SessionAgentId): void {
		this.agentId = next;
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
		if (agents.includes('claude')) return 'claude';
		return agents[0] ?? 'claude';
	}

	applyResolvedModel(agentId: SessionAgentId, model: string, modelEndpointId?: string | null): void {
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
	}

	async loadWorktrees(): Promise<void> {
		if (!this.trimmedPath) return;
		this.isLoadingWorktrees = true;
		this.worktreeError = null;

		try {
			const result = await getGitWorktrees(this.trimmedPath);
			this.worktreeItems = result.worktrees;
		} catch {
			this.worktreeError = 'Failed to load worktrees.';
			this.worktreeItems = [];
		} finally {
			this.isLoadingWorktrees = false;
		}
	}

	selectWorktree(worktreePath: string): void {
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
				this.worktreeError = result.error || result.message || 'Failed to create worktree.';
				return false;
			}
			await this.loadWorktrees();
			this.selectWorktree(result.worktreePath || worktreePath);
			return true;
		} catch (err) {
			this.worktreeError = err instanceof Error ? err.message : 'Failed to create worktree.';
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
		if (!this.trimmedPath) return;
		const next = this.isPinnedPath
			? this.pinnedProjectPaths.filter((p) => p !== this.trimmedPath)
			: [...this.pinnedProjectPaths, this.trimmedPath];
		this.pinnedProjectPaths = next;
		try {
			await this.#remoteSettings.update({
				paths: {
					pinnedProjectPaths: next,
					browseStartPath: this.browseStartPath || this.trimmedPath
				}
			});
		} catch (err) {
			console.warn('[NewChatFormState] Failed to persist pinned project paths', err);
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
		if (!this.firstMessage.trim()) {
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
			permissionMode: normalizePermissionMode(this.permissionMode),
			thinkingMode: normalizeThinkingMode(this.thinkingMode),
			claudeThinkingMode: normalizeClaudeThinkingMode(this.claudeThinkingMode),
			ampAgentMode: this.agentId === 'amp' ? normalizeAmpAgentMode(this.ampAgentMode) : undefined,
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
	}

	// Initialization

	/** Loads server settings without blocking the form on live model discovery. */
	async loadSettingsAndModels(): Promise<void> {
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
			this.validateAllModelsAgainstLive();
		} catch (err) {
			console.warn('[NewChatFormState] Failed to refresh models', err);
		}
	}

	#applySettings(snap: RemoteSettingsSnapshot): void {
		this.projectBasePath = snap.projectBasePath;

		this.pinnedProjectPaths = snap.paths.pinnedProjectPaths ?? [];
		this.browseStartPath = snap.paths.browseStartPath ?? '';

		const defaultPath = snap.lastProjectPath || this.browseStartPath;
		if (defaultPath && !this.projectPath) {
			this.projectPath = defaultPath;
		}

		if (!this.projectPath) {
			this.projectPath = this.projectBasePath;
		}

		this.agentId = this.#resolveStartupAgent(snap.lastAgentId);
		if (snap.lastModel) {
			this.applyResolvedModel(this.agentId, snap.lastModel, snap.lastModelEndpointId);
		} else {
			for (const agentId of this.#modelCatalog.getSelectableAgents()) {
				this.applyResolvedModel(agentId, this.#modelCatalog.getDefaultModel(agentId));
			}
		}
		this.permissionMode = normalizePermissionMode(snap.lastPermissionMode);
		this.thinkingMode = normalizeThinkingMode(snap.lastThinkingMode);
		this.claudeThinkingMode = normalizeClaudeThinkingMode(snap.lastClaudeThinkingMode);
		this.ampAgentMode = normalizeAmpAgentMode(snap.lastAmpAgentMode);
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
