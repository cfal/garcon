// Reactive state management for the new-chat form. Encapsulates provider,
// model, permission/thinking mode, path validation, image attachments, and
// the config payload used to start a session.

import { apiFetch } from '$lib/api/client.js';
import { ImageAttachmentState } from '$lib/chat/image-attachment.svelte.js';
import * as settingsApi from '$lib/api/settings.js';
import { getGitRepoInfo, getGitWorktrees, gitCreateWorktree } from '$lib/api/git.js';
import type { GitWorktreeItem } from '$lib/api/git.js';
import type { NewChatConfig, SessionProvider } from '$lib/types/app.js';
import type { PermissionMode } from '$lib/types/chat.js';
import type { ModelOption } from '$lib/stores/preferences.svelte.js';
import type { PreferencesStore } from '$lib/stores/preferences.svelte.js';
import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import { MODE_STYLES, DEFAULT_MODE_STYLE } from '$lib/chat/provider-state.svelte.js';
import { CLAUDE_PERMISSION_MODES, NON_CLAUDE_PERMISSION_MODES } from '$lib/chat/chat-ui-constants.js';
import { canSubmitNewChat, type PathValidationStatus } from '$lib/components/chat/new-chat-submit.js';
import * as m from '$lib/paraglide/messages.js';

export const PROVIDERS: SessionProvider[] = ['claude', 'codex', 'opencode'];

export const PROVIDER_LABELS: Record<SessionProvider, string> = {
	claude: 'Claude',
	codex: 'Codex',
	opencode: 'OpenCode'
};

export const MODE_LABEL_GETTERS: Record<string, () => string> = {
	default: () => m.chat_new_chat_default_mode(),
	acceptEdits: () => m.chat_new_chat_accept_edits(),
	bypassPermissions: () => m.chat_new_chat_bypass_permissions(),
	plan: () => m.chat_new_chat_plan_mode()
};

export const THINKING_MODE_OPTIONS = [
	{ id: 'none', name: () => m.chat_new_chat_standard() },
	{ id: 'think', name: () => m.chat_new_chat_think() },
	{ id: 'think-hard', name: () => m.chat_new_chat_think_hard() },
	{ id: 'think-harder', name: () => m.chat_new_chat_think_harder() },
	{ id: 'ultrathink', name: () => m.chat_new_chat_ultrathink() }
];

const CLAUDE_DEFAULTS: ModelOption[] = [
	{ value: 'opus', label: 'Opus' },
	{ value: 'sonnet', label: 'Sonnet' },
	{ value: 'haiku', label: 'Haiku' }
];
const CODEX_DEFAULTS: ModelOption[] = [
	{ value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
	{ value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
	{ value: 'gpt-5.2', label: 'GPT-5.2' },
	{ value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
	{ value: 'o3-pro', label: 'o3-pro' },
	{ value: 'o3', label: 'o3' },
	{ value: 'o4-mini', label: 'o4-mini' },
	{ value: 'gpt-4.1', label: 'GPT-4.1' },
	{ value: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
	{ value: 'gpt-4.1-nano', label: 'GPT-4.1 nano' }
];

// Style constants re-exported for use in the template.
export const PILL_BASE =
	'px-3 py-1.5 rounded-lg text-sm font-medium border transition-all duration-200';
export const PROVIDER_PILL_WIDTH = 'w-[6.75rem] sm:w-[7.5rem] shrink-0';
export const THINKING_PILL_WIDTH = 'w-[7.25rem] sm:w-[8rem] shrink-0';

export class NewChatFormState {
	// Provider and model
	provider = $state<SessionProvider>('claude');
	claudeModel = $state('opus');
	codexModel = $state('gpt-5.3-codex');
	opencodeModel = $state('');
	providerModels = $state<Partial<Record<SessionProvider, ModelOption[]>>>({});

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
	thinkingMode = $state('none');

	// Form
	firstMessage = $state('');
	error = $state<string | null>(null);
	showBrowser = $state(false);
	hasAutoOpened = $state(false);
	settingsLoaded = $state(false);

	// Git repo detection
	gitRepoStatus = $state<'unknown' | 'checking' | 'git' | 'non-git' | 'error'>('unknown');
	repoRootPath = $state<string | null>(null);

	// Worktree modal
	worktreeModalOpen = $state(false);
	worktreeItems = $state<GitWorktreeItem[]>([]);
	isLoadingWorktrees = $state(false);
	isCreatingWorktree = $state(false);
	worktreeError = $state<string | null>(null);
	#gitDetectionVersion = 0;

	// Images (delegated to shared ImageAttachmentState)
	readonly #images = new ImageAttachmentState();

	// Injected dependencies
	readonly #preferences: PreferencesStore;
	readonly #appShell: AppShellStore;

	constructor(preferences: PreferencesStore, appShell: AppShellStore) {
		this.#preferences = preferences;
		this.#appShell = appShell;

		this.provider = preferences.selectedProvider || 'claude';
		this.claudeModel = preferences.claudeModel || 'opus';
		this.codexModel = preferences.codexModel || 'gpt-5.3-codex';
		this.opencodeModel = preferences.opencodeModel || '';
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

	get modeStyle(): { button: string; dot: string } {
		return MODE_STYLES[this.permissionMode] || DEFAULT_MODE_STYLE;
	}

	get currentThinkingMode(): (typeof THINKING_MODE_OPTIONS)[number] {
		return THINKING_MODE_OPTIONS.find((t) => t.id === this.thinkingMode) || THINKING_MODE_OPTIONS[0];
	}

	get providerName(): string {
		return PROVIDER_LABELS[this.provider];
	}

	get canSubmit(): boolean {
		return canSubmitNewChat(this.trimmedPath, this.validationStatus);
	}

	get placeholder(): string {
		return this.canSubmit
			? `Type @ for files, or ask ${this.providerName} anything...`
			: 'Enter a valid project path first';
	}

	get modelOptions(): ModelOption[] {
		const opts: Record<SessionProvider, ModelOption[]> = {
			claude: this.providerModels.claude?.length
				? this.providerModels.claude
				: CLAUDE_DEFAULTS,
			codex: this.providerModels.codex?.length
				? this.providerModels.codex
				: CODEX_DEFAULTS,
			opencode: this.providerModels.opencode?.length
				? this.providerModels.opencode
				: this.opencodeModel
					? [{ value: this.opencodeModel, label: this.opencodeModel }]
					: []
		};
		return opts[this.provider];
	}

	get modelValue(): string {
		const map: Record<SessionProvider, string> = {
			claude: this.claudeModel,
			codex: this.codexModel,
			opencode: this.opencodeModel
		};
		return map[this.provider];
	}

	// Provider cycling

	selectProvider(next: SessionProvider): void {
		this.provider = next;
		this.#preferences.setPreference('selectedProvider', next);
	}

	cycleProvider(): void {
		const idx = PROVIDERS.indexOf(this.provider);
		this.selectProvider(PROVIDERS[(idx + 1) % PROVIDERS.length]);
	}

	// Model

	handleModelChange(value: string): void {
		const setterMap: Record<SessionProvider, (v: string) => void> = {
			claude: (v) => { this.claudeModel = v; },
			codex: (v) => { this.codexModel = v; },
			opencode: (v) => { this.opencodeModel = v; }
		};
		setterMap[this.provider](value);
	}

	/** Validates the selected model against the live model list for a provider. */
	validateModelAgainstLive(provider: SessionProvider): void {
		const liveModels = this.providerModels[provider];
		if (!liveModels?.length) return;

		if (provider === 'opencode' && !liveModels.some((m) => m.value === this.opencodeModel)) {
			this.opencodeModel = liveModels[0].value;
		}
		if (provider === 'claude' && !liveModels.some((m) => m.value === this.claudeModel)) {
			this.claudeModel = liveModels[0].value;
		}
	}

	// Permission mode

	cyclePermissionMode(): void {
		const modes = this.permissionModes;
		const idx = modes.indexOf(this.permissionMode);
		this.permissionMode = modes[(idx + 1) % modes.length];
	}

	// Thinking mode

	cycleThinkingMode(): void {
		const ids = THINKING_MODE_OPTIONS.map((t) => t.id);
		const idx = ids.indexOf(this.thinkingMode);
		this.thinkingMode = ids[(idx + 1) % ids.length];
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

	// Git repo detection

	/** Probes the validated path for git repository status. */
	async detectGitRepo(): Promise<void> {
		if (this.validationStatus !== 'valid' || !this.trimmedPath) {
			this.gitRepoStatus = 'unknown';
			this.repoRootPath = null;
			return;
		}

		this.gitRepoStatus = 'checking';
		const version = ++this.#gitDetectionVersion;

		try {
			const info = await getGitRepoInfo(this.trimmedPath);
			if (version !== this.#gitDetectionVersion) return;

			if (info.isGitRepository) {
				this.gitRepoStatus = 'git';
				this.repoRootPath = info.repoRoot ?? null;
			} else {
				this.gitRepoStatus = 'non-git';
				this.repoRootPath = null;
			}
		} catch {
			if (version !== this.#gitDetectionVersion) return;
			this.gitRepoStatus = 'error';
			this.repoRootPath = null;
		}
	}

	// Worktree modal

	async openWorktreeModal(): Promise<void> {
		this.worktreeModalOpen = true;
		this.worktreeError = null;
		await this.loadWorktrees();
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
				const res = await apiFetch(
					`/api/v1/files/validate-dir?path=${encodeURIComponent(path)}`
				);
				const data = await res.json();
				if (requestVersion !== this.#validationRequestVersion) return;
				if (data.valid) {
					this.validationStatus = 'valid';
					this.validationError = null;
				} else {
					this.validationStatus = 'invalid';
					this.validationError = m.chat_new_chat_errors_invalid_directory();
				}
			} catch (err) {
				if (requestVersion !== this.#validationRequestVersion) return;
				this.validationStatus = 'invalid';
				this.validationError = m.chat_new_chat_errors_invalid_directory();
				console.warn('[NewChatFormState] Path validation request failed', err);
			}
		}, 300);
	}

	#clearValidation(): void {
		if (this.#validationTimer) {
			clearTimeout(this.#validationTimer);
			this.#validationTimer = null;
		}
		this.#validationRequestVersion += 1;
		this.validationStatus = 'idle';
		this.validationError = null;
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
		this.error = null;

		// Persist last-used path and modes (fire and forget).
		settingsApi.updateSettings({
			paths: { lastProjectPath: this.trimmedPath },
			lastPermissionMode: this.permissionMode,
			lastThinkingMode: this.thinkingMode
		}).catch((err) => {
			console.warn('[NewChatFormState] Failed to persist settings', err);
		});

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
		this.repoRootPath = null;
		this.worktreeModalOpen = false;
		this.worktreeItems = [];
		this.worktreeError = null;
	}

	// Initialization

	/** Loads server settings and model lists. */
	async loadSettingsAndModels(): Promise<void> {
		try {
			const [settingsData, modelsRes] = await Promise.all([
				settingsApi.getSettings(),
				apiFetch('/api/v1/models')
			]);

			if (settingsData) {
				this.#applySettings(settingsData);
			}

			if (modelsRes.ok) {
				const models = await modelsRes.json();
				this.providerModels = models;
				if (models.claude) this.#preferences.setProviderModels('claude', models.claude);
				if (models.codex) this.#preferences.setProviderModels('codex', models.codex);
				if (models.opencode) this.#preferences.setProviderModels('opencode', models.opencode);
			}
		} catch (err) {
			console.warn('[NewChatFormState] Failed to load settings and models', err);
		} finally {
			this.settingsLoaded = true;
		}
	}

	#applySettings(settingsData: Record<string, unknown>): void {
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
			const lastPath =
				typeof paths.lastProjectPath === 'string' ? paths.lastProjectPath : '';
			this.pinnedProjectPaths = pinned;
			this.browseStartPath = browse;
			const defaultPath = lastPath || browse;
			if (defaultPath && !this.projectPath) {
				this.projectPath = defaultPath;
			}
		}

		if (!this.projectPath) {
			this.projectPath = this.projectBasePath;
		}

		if (typeof settingsData.lastPermissionMode === 'string' && settingsData.lastPermissionMode) {
			this.permissionMode = settingsData.lastPermissionMode as PermissionMode;
		}
		if (typeof settingsData.lastThinkingMode === 'string' && settingsData.lastThinkingMode !== 'none') {
			this.thinkingMode = settingsData.lastThinkingMode;
		}
	}

	// Auto-open browser on first path focus

	handlePathFocus(): void {
		if (!this.hasAutoOpened) {
			this.hasAutoOpened = true;
			this.showBrowser = true;
		}
	}
}
