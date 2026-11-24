import { getGitWorktrees, type GitWorktreeItem } from '$lib/api/git.js';
import { projectPathKey } from '$shared/project-path-preferences';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import * as m from '$lib/paraglide/messages.js';

export interface NewChatWorktreeStateOptions {
	getExecutorId(): string;
	getProjectPath(): string;
	getContextKey(): string;
	getInstanceId(): string | null;
	isAvailable(): boolean;
	isSelectionDisabled(): boolean;
	selectPath(path: string): void;
}

/** Owns inline worktree discovery and selection on the New Chat landing. */
export class NewChatWorktreeState {
	items = $state<GitWorktreeItem[]>([]);
	isLoading = $state(false);
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
		this.cancelLoad();
		this.#options.selectPath(path);
		this.#targetKey = `${this.contextKey}\u0000${this.#options.getProjectPath()}`;
	}

	async load(): Promise<void> {
		if (!this.available) return;
		const projectPath = this.#options.getProjectPath();
		const executorId = this.#options.getExecutorId();
		const contextKey = this.contextKey;
		const instanceId = this.#options.getInstanceId();
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
			if (result.executorId !== executorId || (instanceId !== null && result.instanceId !== instanceId)) {
				this.error = m.git_target_load_worktrees_failed();
				return;
			}
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
	}

	#isCurrentLoad(requestVersion: number, signal: AbortSignal): boolean {
		return !signal.aborted && requestVersion === this.#requestVersion;
	}
}
