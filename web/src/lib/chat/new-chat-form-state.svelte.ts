// Reactive state management for the new-chat form. Encapsulates provider,
// model, permission/thinking mode, path validation, image attachments, and
// the config payload used to start a session.

import { browseDirectory } from '$lib/api/files.js';
import { validateStart, type ValidateStartErrorCode } from '$lib/api/chats.js';
import { ImageAttachmentState } from '$lib/chat/image-attachment.svelte.js';
import * as settingsApi from '$lib/api/settings.js';
import { getGitWorktrees, gitCreateWorktree } from '$lib/api/git.js';
import type { GitWorktreeItem } from '$lib/api/git.js';
import type { NewChatConfig, SessionProvider } from '$lib/types/app.js';
import type { AppSettings } from '$lib/types/session.js';
import type { PermissionMode, ThinkingMode } from '$lib/types/chat.js';
import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import type { ModelCatalogStore, ModelOption } from '$lib/stores/model-catalog.svelte.js';
import { CLAUDE_PERMISSION_MODES, NON_CLAUDE_PERMISSION_MODES } from '$lib/chat/chat-ui-constants.js';
import { canSubmitNewChat, type PathValidationStatus } from '$lib/components/chat/new-chat-submit.js';
import * as m from '$lib/paraglide/messages.js';

export class NewChatFormState {
	// Provider and model
	provider = $state<SessionProvider>('claude');
	claudeModel = $state('');
	codexModel = $state('');
	opencodeModel = $state('');
	ampModel = $state('');

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

	constructor(appShell: AppShellStore, modelCatalog: ModelCatalogStore) {
		this.#appShell = appShell;
		this.#modelCatalog = modelCatalog;

	}

	// Derived accessors

	get trimmedPath(): string {
		return this.projectPath.trim();
	}

	get isPinnedPath(): boolean {
		return Boolean(this.trimmedPath) && this.pinnedProjectPaths.includes(this.trimmedPath);
	}

	get permissionModes(): PermissionMode[] {
		return this.provider === 'claude' ? CLAUDE_PERMISSION_MODES : NON_CLAUDE_PERMISSION_MODES;
	}

	get canSubmit(): boolean {
		return this.settingsLoaded && canSubmitNewChat(this.trimmedPath, this.validationStatus, this.firstMessage);
	}

	get placeholder(): string {
		return m.chat_new_chat_placeholder();
	}

	get modelOptions(): ModelOption[] {
		const opts: Record<SessionProvider, ModelOption[]> = {
			claude: this.#modelCatalog.getModels('claude'),
			codex: this.#modelCatalog.getModels('codex'),
			opencode: this.#modelCatalog.getModels('opencode').length
				? this.#modelCatalog.getModels('opencode')
				: this.opencodeModel
					? [{ value: this.opencodeModel, label: this.opencodeModel }]
					: [],
			amp: this.#modelCatalog.getModels('amp').length
				? this.#modelCatalog.getModels('amp')
				: this.ampModel
					? [{ value: this.ampModel, label: this.ampModel }]
					: []
		};
		return opts[this.provider];
	}

	get modelValue(): string {
		const map: Record<SessionProvider, string> = {
			claude: this.claudeModel,
			codex: this.codexModel,
			opencode: this.opencodeModel,
			amp: this.ampModel
		};
		return map[this.provider];
	}

	// Provider cycling

	selectProvider(next: SessionProvider): void {
		this.provider = next;
	}

	// Model

	handleModelChange(value: string): void {
		const setterMap: Record<SessionProvider, (v: string) => void> = {
			claude: (v) => { this.claudeModel = v; },
			codex: (v) => { this.codexModel = v; },
			opencode: (v) => { this.opencodeModel = v; },
			amp: (v) => { this.ampModel = v; }
		};
		setterMap[this.provider](value);
	}

	/** Validates the selected model against the live model list for a provider. */
	validateModelAgainstLive(provider: SessionProvider): void {
		const liveModels = this.#modelCatalog.getModels(provider);
		if (!liveModels?.length) return;

		if (provider === 'opencode' && !liveModels.some((m) => m.value === this.opencodeModel)) {
			this.opencodeModel = liveModels[0].value;
		}
		if (provider === 'claude' && !liveModels.some((m) => m.value === this.claudeModel)) {
			this.claudeModel = liveModels[0].value;
		}
		if (provider === 'codex' && !liveModels.some((m) => m.value === this.codexModel)) {
			this.codexModel = liveModels[0].value;
		}
		if (provider === 'amp' && !liveModels.some((m) => m.value === this.ampModel)) {
			this.ampModel = liveModels[0].value;
		}
	}

	applyResolvedModel(provider: SessionProvider, model: string): void {
		const liveModels = this.#modelCatalog.getModels(provider);
		const resolvedModel = liveModels.some((entry) => entry.value === model)
			? model
			: (liveModels[0]?.value ?? model);
		if (provider === 'claude') this.claudeModel = resolvedModel;
		if (provider === 'codex') this.codexModel = resolvedModel;
		if (provider === 'opencode') this.opencodeModel = resolvedModel;
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
			this.selectWorktree(worktreePath);
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
			await settingsApi.updateSettings({
				paths: {
					pinnedProjectPaths: next,
					browseStartPath: this.browseStartPath || this.trimmedPath
				}
			});
		} catch (err) {
			console.warn('[NewChatFormState] Failed to persist pinned project paths', err);
		}
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

		return {
			provider: this.provider,
			projectPath: this.trimmedPath,
			model: this.modelValue,
			permissionMode: this.permissionMode,
			thinkingMode: this.thinkingMode,
			firstMessage: this.firstMessage.trim(),
			initialImages: this.attachedImages
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
	}

	// Initialization

	/** Loads server settings and refreshes models when the cache is stale. */
	async loadSettingsAndModels(): Promise<void> {
		try {
			const [settingsData] = await Promise.all([
				settingsApi.getSettings(),
				this.#modelCatalog.refreshIfStale()
			]);

			if (settingsData) {
				this.#applySettings(settingsData);
			}
			this.validateModelAgainstLive('claude');
			this.validateModelAgainstLive('codex');
			this.validateModelAgainstLive('opencode');
			this.validateModelAgainstLive('amp');
		} catch (err) {
			console.warn('[NewChatFormState] Failed to load settings and models', err);
			this.applyResolvedModel('claude', this.#modelCatalog.getDefaultModel('claude'));
			this.applyResolvedModel('codex', this.#modelCatalog.getDefaultModel('codex'));
			this.applyResolvedModel('opencode', this.#modelCatalog.getDefaultModel('opencode'));
			if (!this.projectPath) {
				this.projectPath = this.projectBasePath;
			}
		} finally {
			this.settingsLoaded = true;
		}
	}

	#applySettings(settingsData: AppSettings): void {
		if (typeof settingsData.projectBasePath === 'string') {
			this.projectBasePath = settingsData.projectBasePath;
			this.#appShell.projectBasePath = settingsData.projectBasePath;
		}

			const paths = settingsData.paths as Record<string, unknown> | undefined;
			if (paths) {
				const pinned = Array.isArray(paths.pinnedProjectPaths)
					? (paths.pinnedProjectPaths as string[])
					: [];
				const browse =
					typeof paths.browseStartPath === 'string' ? paths.browseStartPath : '';
				this.pinnedProjectPaths = pinned;
				this.browseStartPath = browse;
				const defaultPath =
					(typeof settingsData.lastProjectPath === 'string' ? settingsData.lastProjectPath : '') || browse;
				if (defaultPath && !this.projectPath) {
					this.projectPath = defaultPath;
				}
			}

		if (!this.projectPath) {
			this.projectPath = this.projectBasePath;
		}

		if (typeof settingsData.lastProvider === 'string') {
			this.provider = settingsData.lastProvider as SessionProvider;
		}
		if (typeof settingsData.lastModel === 'string' && settingsData.lastModel) {
			this.applyResolvedModel(this.provider, settingsData.lastModel);
		} else {
			this.applyResolvedModel('claude', this.#modelCatalog.getDefaultModel('claude'));
			this.applyResolvedModel('codex', this.#modelCatalog.getDefaultModel('codex'));
			this.applyResolvedModel('opencode', this.#modelCatalog.getDefaultModel('opencode'));
		}
		if (typeof settingsData.lastPermissionMode === 'string' && settingsData.lastPermissionMode) {
			this.permissionMode = settingsData.lastPermissionMode;
		}
		if (typeof settingsData.lastThinkingMode === 'string') {
			this.thinkingMode = settingsData.lastThinkingMode;
		}
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
