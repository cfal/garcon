import { getGitWorktrees, gitCreateWorktree, type GitWorktreeItem } from '$lib/api/git.js';
import { projectPathKey } from '$shared/project-path-preferences';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import * as m from '$lib/paraglide/messages.js';

export interface NewChatWorktreeStateOptions {
	getExecutorId(): string;
	getProjectPath(): string;
	getContextKey(): string;
	isAvailable(): boolean;
	isSelectionDisabled(): boolean;
	selectPath(path: string): void;
}

/** Owns worktree discovery and selection for new-chat and scheduled-chat composers. */
export class NewChatWorktreeState {
	modalOpen = $state(false);
	items = $state<GitWorktreeItem[]>([]);
	isLoading = $state(false);
	isCreating = $state(false);
	error = $state<string | null>(null);
	#targetKey = $state<string | null>(null);
	#requestVersion = 0;
	#abort: AbortController | null = null;
	readonly #options: NewChatWorktreeStateOptions;

	constructor(options: NewChatWorktreeStateOptions) {
		this.#options = options;
	}

	get available(): boolean {
		return this.#options.isAvailable();
	}

	get contextKey(): string {
		return this.#options.getContextKey();
	}

	get listed(): GitWorktreeItem[] {
		return this.hasListed ? this.items : [];
	}

	get hasListed(): boolean {
		return this.#targetKey === `${this.contextKey}\u0000${this.#options.getProjectPath()}`;
	}

	isSelected(path: string): boolean {
		return projectPathKey(this.#options.getProjectPath()) === projectPathKey(path);
	}

	clear(): void {
		this.cancelLoad();
		this.#targetKey = null;
		this.items = [];
		this.error = null;
	}

	selectListed(path: string): void {
		if (this.isLoading || this.#options.isSelectionDisabled() || !this.available) return;
		if (!this.listed.some((item) => item.path === path && !item.isPathMissing)) return;
		this.select(path);
		this.#targetKey = `${this.contextKey}\u0000${this.#options.getProjectPath()}`;
	}

	openModal(): void {
		if (!this.available) return;
		this.modalOpen = true;
		this.error = null;
		this.items = [];
		void this.load();
	}

	closeModal(): void {
		this.modalOpen = false;
		this.error = null;
		this.cancelLoad();
	}

	async load(): Promise<void> {
		if (!this.available) return;
		const projectPath = this.#options.getProjectPath();
		const executorId = this.#options.getExecutorId();
		const contextKey = this.contextKey;
		if (!projectPath) return;

		this.#abort?.abort();
		const abort = new AbortController();
		this.#abort = abort;
		const requestVersion = ++this.#requestVersion;
		this.isLoading = true;
		this.error = null;
		this.#targetKey = `${contextKey}\u0000${projectPath}`;
		this.items = [];

		try {
			const result = await getGitWorktrees({ executorId, projectPath }, { signal: abort.signal });
			if (
				executorId !== this.#options.getExecutorId() ||
				projectPath !== this.#options.getProjectPath() ||
				contextKey !== this.contextKey
			)
				return;
			if (!this.#isCurrentLoad(requestVersion, abort.signal)) return;
			this.items = result.worktrees;
		} catch (error) {
			if (
				isAbortError(error) ||
				!this.#isCurrentLoad(requestVersion, abort.signal) ||
				executorId !== this.#options.getExecutorId() ||
				projectPath !== this.#options.getProjectPath() ||
				contextKey !== this.contextKey
			) {
				return;
			}
			this.error = m.git_target_load_worktrees_failed();
			this.items = [];
		} finally {
			if (this.#isCurrentLoad(requestVersion, abort.signal)) {
				this.#abort = null;
				this.isLoading = false;
			}
		}
	}

	cancelLoad(): void {
		this.#abort?.abort();
		this.#abort = null;
		this.#requestVersion += 1;
		this.isLoading = false;
		this.isCreating = false;
	}

	#isCurrentLoad(requestVersion: number, signal: AbortSignal): boolean {
		return !signal.aborted && requestVersion === this.#requestVersion;
	}

	async create(worktreePath: string, branch?: string, baseRef?: string): Promise<boolean> {
		if (!this.available || this.isCreating) return false;
		const projectPath = this.#options.getProjectPath();
		const executorId = this.#options.getExecutorId();
		const contextKey = this.contextKey;
		if (!projectPath) return false;
		const generation = this.#requestVersion;
		const current = () =>
			generation === this.#requestVersion &&
			executorId === this.#options.getExecutorId() &&
			projectPath === this.#options.getProjectPath() &&
			contextKey === this.contextKey;
		this.isCreating = true;
		this.error = null;

		try {
			const result = await gitCreateWorktree({ executorId, projectPath }, worktreePath, {
				branch,
				baseRef,
			});
			if (!current()) return false;
			if (!result.success) {
				this.error = result.error || result.message || m.chat_new_chat_create_worktree_failed();
				return false;
			}
			this.select(result.worktreePath || worktreePath);
			return true;
		} catch (err) {
			if (!current()) return false;
			this.error = err instanceof Error ? err.message : m.chat_new_chat_create_worktree_failed();
			return false;
		} finally {
			if (generation === this.#requestVersion) this.isCreating = false;
		}
	}

	select(path: string): void {
		if (!this.available) return;
		this.cancelLoad();
		this.#options.selectPath(path);
		this.modalOpen = false;
	}
}
