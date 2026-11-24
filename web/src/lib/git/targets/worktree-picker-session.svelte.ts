import { SvelteSet } from 'svelte/reactivity';
import { ApiError } from '$lib/api/client.js';
import { getGitWorktrees, gitCreateWorktree, type GitWorktreeCreation, type GitWorktreeItem } from '$lib/api/git.js';
import type { GitProjectTarget } from '$lib/api/git-client.js';
import * as m from '$lib/paraglide/messages.js';
import { gitProjectKey, sameGitProject } from './git-target.js';

export type WorktreeCreateResult = { error: string } | { createdPath: string };

interface WorktreeNotice {
	target: GitProjectTarget;
	result: WorktreeCreateResult;
}

interface WorktreePickerOptions {
	target(): GitProjectTarget;
	servingContext(): string | null;
	servingInstanceId(): string | null;
	select(path: string): void;
}

export class WorktreePickerSession {
	worktrees = $state.raw<GitWorktreeItem[]>([]);
	loadError = $state<string | null>(null);
	createResult = $state.raw<WorktreeCreateResult | null>(null);

	#visit = $state.raw<GitProjectTarget | null>(null);
	#read = $state.raw<AbortController | null>(null);
	#requestedContext = $state<string | null>(null);
	#lastCatalogInstanceId = $state<string | null>(null);
	#pending = new SvelteSet<string>();

	constructor(private readonly options: WorktreePickerOptions) {}

	get isOpen(): boolean { return this.#visit !== null; }
	get isLoading(): boolean { return this.#read !== null; }
	get contextKey(): string { return gitProjectKey(this.options.target()); }
	get catalogContextKey(): string | null { return this.options.servingContext(); }
	get isCreating(): boolean { return this.#pending.has(this.contextKey); }
	get canRefresh(): boolean {
		if (this.isLoading || this.isCreating) return false;
		const context = this.catalogContextKey;
		if (context === null || context !== this.#requestedContext) return false;
		return sameGitProject(this.#visit, this.options.target());
	}
	get canUseGit(): boolean {
		if (!this.canRefresh) return false;
		const instance = this.options.servingInstanceId();
		return instance === null || this.#lastCatalogInstanceId === null || this.#lastCatalogInstanceId === instance;
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
		this.#lastCatalogInstanceId = null;
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
		if (!sameGitProject(visit, this.options.target())) {
			this.close();
			return;
		}
		const context = this.catalogContextKey;
		if (context === null) {
			this.#invalidateCatalog();
			this.loadError = null;
			return;
		}
		if (this.isCreating || context === this.#requestedContext) return;
		this.#read?.abort();
		const read = new AbortController();
		this.#read = read;
		this.#requestedContext = context;
		this.loadError = null;
		const expectedInstance = this.options.servingInstanceId();
		const catalog = await getGitWorktrees(visit, { signal: read.signal }).catch(() => null);
		if (this.#read === read) this.#read = null;
		if (read.signal.aborted || !this.#isCurrentVisit(visit) || this.catalogContextKey !== context) return;
		if (catalog) this.#lastCatalogInstanceId = catalog.instanceId;
		if (!catalog || (expectedInstance !== null && catalog.instanceId !== expectedInstance)) {
			this.loadError = m.git_target_load_worktrees_failed();
			this.worktrees = [];
			return;
		}
		this.worktrees = catalog.worktrees;
	}

	select(path: string): void {
		if (this.canUseGit) this.#select(path);
	}

	async create(creation: GitWorktreeCreation): Promise<WorktreeNotice | void> {
		const visit = this.#visit;
		const context = this.catalogContextKey;
		if (!visit || !this.canUseGit) return;
		const key = gitProjectKey(visit);
		// The first Local catalog can arrive before the browser's first executor snapshot.
		const expectedInstance = this.options.servingInstanceId() ?? this.#lastCatalogInstanceId;
		this.#pending.add(key);
		this.createResult = null;
		let result: WorktreeCreateResult;
		let uncertain = false;
		let replyInstance: string | undefined;
		try {
			const reply = await gitCreateWorktree(visit, creation);
			replyInstance = reply.instanceId;
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
		if (current && 'createdPath' in result && context === this.catalogContextKey && replyInstance === expectedInstance) {
			this.#select(result.createdPath);
			return;
		}
		if (current) this.createResult = result;
		// Even a failed create may have changed Git. A later visit needs the catalog, not this visit's result.
		if (sameGitProject(this.#visit, visit)) void this.refresh();
		if (!current || uncertain) return { target: visit, result };
	}

	#isCurrentVisit(visit: GitProjectTarget): boolean {
		return visit === this.#visit && sameGitProject(visit, this.options.target());
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
