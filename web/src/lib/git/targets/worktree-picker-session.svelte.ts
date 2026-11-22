import { SvelteSet } from 'svelte/reactivity';
import { ApiError } from '$lib/api/client.js';
import { getGitWorktrees, gitCreateWorktree, type GitWorktreeCreation, type GitWorktreeItem } from '$lib/api/git.js';
import type { GitProjectTarget } from '$lib/api/git-client.js';
import * as m from '$lib/paraglide/messages.js';

export type WorktreeCreateResult = { error: string } | { createdPath: string };

interface WorktreeNotice {
	target: GitProjectTarget;
	result: WorktreeCreateResult;
}

interface WorktreePickerOptions {
	target(): GitProjectTarget;
	servingContext(): string | null;
	select(path: string): void;
}

function targetKey({ executorId, projectPath }: GitProjectTarget): string {
	return JSON.stringify([executorId, projectPath]);
}

export class WorktreePickerSession {
	worktrees = $state.raw<GitWorktreeItem[]>([]);
	loadError = $state<string | null>(null);
	createResult = $state.raw<WorktreeCreateResult | null>(null);

	#visit = $state.raw<GitProjectTarget | null>(null);
	#read = $state.raw<AbortController | null>(null);
	#requestedContext = $state<string | null>(null);
	#pending = new SvelteSet<string>();

	constructor(private readonly options: WorktreePickerOptions) {}

	get isOpen(): boolean { return this.#visit !== null; }
	get isLoading(): boolean { return this.#read !== null; }
	get contextKey(): string { return targetKey(this.options.target()); }
	get catalogContextKey(): string | null { return this.options.servingContext(); }
	get isCreating(): boolean { return this.#pending.has(this.contextKey); }
	get canUseGit(): boolean {
		const visit = this.#visit;
		const context = this.catalogContextKey;
		return !!visit && this.#isCurrentVisit(visit) && context !== null && this.#requestedContext === context &&
			!this.isLoading && !this.isCreating;
	}

	open(): Promise<void> {
		const target = this.options.target();
		if (!target.projectPath || this.catalogContextKey === null) return Promise.resolve();
		this.close();
		// Object identity distinguishes two visits to the same executor and path.
		this.#visit = { ...target };
		return this.syncCatalog();
	}

	close(): void {
		this.#visit = null;
		this.#invalidateCatalog();
		this.worktrees = [];
		this.loadError = null;
		this.createResult = null;
	}

	refresh(): Promise<void> {
		this.#invalidateCatalog();
		return this.syncCatalog();
	}

	async syncCatalog(): Promise<void> {
		const visit = this.#visit;
		if (!visit) return;
		if (targetKey(visit) !== this.contextKey) {
			this.close();
			return;
		}
		const context = this.catalogContextKey;
		if (context === null) {
			this.#invalidateCatalog();
			return;
		}
		if (this.isCreating || context === this.#requestedContext) return;
		this.#invalidateCatalog();
		const read = new AbortController();
		this.#read = read;
		this.#requestedContext = context;
		this.loadError = null;
		const current = () => !read.signal.aborted && this.#isCurrentVisit(visit) && this.catalogContextKey === context;
		try {
			const result = await getGitWorktrees(visit, { signal: read.signal });
			if (current()) this.worktrees = result.worktrees;
		} catch {
			if (current()) {
				this.loadError = m.git_target_load_worktrees_failed();
				this.worktrees = [];
			}
		} finally {
			if (this.#read === read) this.#read = null;
		}
	}

	select(path: string): void {
		if (this.canUseGit) this.#select(path);
	}

	async create(creation: GitWorktreeCreation): Promise<WorktreeNotice | void> {
		const visit = this.#visit;
		const context = this.catalogContextKey;
		if (!visit || !this.canUseGit) return;
		const key = targetKey(visit);
		this.#pending.add(key);
		this.createResult = null;
		let result: WorktreeCreateResult;
		let uncertain = false;
		try {
			const reply = await gitCreateWorktree(visit, creation);
			result = reply.success
				? { createdPath: reply.worktreePath || creation.worktreePath }
				: { error: reply.error || reply.message || m.chat_new_chat_create_worktree_failed() };
		} catch (error) {
			result = { error: error instanceof Error ? error.message : m.chat_new_chat_create_worktree_failed() };
			uncertain = error instanceof ApiError && error.errorCode === 'GIT_MUTATION_OUTCOME_UNKNOWN';
		} finally {
			this.#pending.delete(key);
		}
		const current = this.#isCurrentVisit(visit);
		if (current && 'createdPath' in result && context === this.catalogContextKey) {
			this.#select(result.createdPath);
			return;
		}
		if (current) this.createResult = result;
		// Even a failed create may have changed Git. A later visit needs the catalog, not this visit's result.
		if (this.#visit && targetKey(this.#visit) === key) void this.refresh();
		if (!current || uncertain) return { target: visit, result };
	}

	#isCurrentVisit(visit: GitProjectTarget): boolean {
		return visit === this.#visit && targetKey(visit) === this.contextKey;
	}

	#invalidateCatalog(): void {
		this.#read?.abort();
		this.#read = null;
		this.#requestedContext = null;
	}

	#select(path: string): void {
		this.close();
		this.options.select(path);
	}
}
