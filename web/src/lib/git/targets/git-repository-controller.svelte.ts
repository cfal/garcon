import type { GitProjectTarget } from '$lib/api/git-client.js';
import { sameGitProject } from './git-target.js';
import { ApiError } from '$lib/api/client.js';
import {
	type GitRemoteStatus,
	type GitRemoteEntry,
	getRemoteStatus as fetchRemoteStatusApi,
	getGitRemotes,
	gitPush,
} from '$lib/api/git.js';
import type { GitBranchSelectorState } from './git-branch-selector-state.svelte.js';

export class GitRepositoryController {
	remoteStatus = $state<GitRemoteStatus | null>(null);
	isPushing = $state(false);
	pushPrompt = $state<{
		project: GitProjectTarget;
		branch: string;
		remotes: GitRemoteEntry[];
		selectedRemote: string;
	} | null>(null);
	lastError = $state<string | null>(null);
	private contextGeneration = 0;
	private project: GitProjectTarget | null = null;
	private remoteStatusGeneration = 0;
	private errorTimeout: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly branchSelector: GitBranchSelectorState) {}

	get pushBranch(): string {
		return this.remoteStatus?.branch === this.branchSelector.currentBranch
			? this.branchSelector.currentBranch
			: '';
	}

	private surfaceError(message: string): void {
		this.dismissError();
		this.lastError = message;
		this.errorTimeout = setTimeout(() => this.dismissError(), 6000);
	}

	dismissError(): void {
		if (this.errorTimeout !== null) clearTimeout(this.errorTimeout);
		this.errorTimeout = null;
		this.lastError = null;
	}

	async fetchRemoteStatus(project: GitProjectTarget): Promise<void> {
		const contextGeneration = this.captureContext(project);
		if (contextGeneration === null) return;
		const generation = ++this.remoteStatusGeneration;
		try {
			const data = await fetchRemoteStatusApi(project);
			if (
				generation !== this.remoteStatusGeneration ||
				!this.isCurrentContext(project, contextGeneration)
			)
				return;
			this.remoteStatus = !data.error ? data : null;
			if (!this.branchSelector.currentBranch && !data.error && data.branch)
				this.branchSelector.currentBranch = data.branch;
		} catch (err) {
			if (
				generation !== this.remoteStatusGeneration ||
				!this.isCurrentContext(project, contextGeneration)
			)
				return;
			// The Git surface reports executor outages itself and refreshes once the executor returns.
			if (!(err instanceof ApiError && err.errorCode === 'EXECUTOR_UNAVAILABLE')) {
				console.error('[Git] Error fetching remote status:', err);
			}
			this.remoteStatus = null;
		}
	}

	refreshDeferredMetadata(project: GitProjectTarget): void {
		this.fetchRemoteStatus(project);
	}

	suspend(): void {
		this.contextGeneration++;
		this.remoteStatusGeneration++;
		this.isPushing = false;
		this.pushPrompt = null;
		this.dismissError();
	}

	resetForProject(
		project: GitProjectTarget | null,
		options: { deferMetadata?: boolean } = {},
	): void {
		this.suspend();
		this.project = project;
		this.remoteStatus = null;
		if (project && !options.deferMetadata) this.refreshDeferredMetadata(project);
	}

	async handlePush(
		project: GitProjectTarget,
		remote?: string,
		remoteBranch?: string,
	): Promise<boolean> {
		const contextGeneration = this.captureContext(project);
		if (contextGeneration === null) return false;
		this.pushPrompt = null;
		this.isPushing = true;
		try {
			const result = await gitPush(project, remote, remoteBranch);
			if (!this.isCurrentContext(project, contextGeneration)) return Boolean(result.success);
			if (result.success) {
				await this.fetchRemoteStatus(project);
				return true;
			}
			this.surfaceError(result.error ?? 'Git action failed');
			return false;
		} catch (error) {
			if (this.isCurrentContext(project, contextGeneration)) {
				this.surfaceError(
					`Git action failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			throw error;
		} finally {
			if (this.isCurrentContext(project, contextGeneration)) this.isPushing = false;
		}
	}

	async preparePush(project: GitProjectTarget): Promise<void> {
		const branch = this.pushBranch;
		if (!branch || !this.remoteStatus?.hasRemote || this.captureContext(project) === null) return;
		this.pushPrompt = { project, branch, remotes: [], selectedRemote: '' };
		const prompt = this.pushPrompt;
		const { remotes } = await getGitRemotes(project).catch(() => ({ remotes: [] }));
		if (this.pushPrompt !== prompt) return;
		if (!remotes?.length || branch !== this.pushBranch) {
			this.pushPrompt = null;
			return;
		}
		prompt.remotes = remotes;
		prompt.selectedRemote =
			remotes.find((remote) => remote.name === 'origin')?.name ?? remotes[0].name;
	}

	private captureContext(project: GitProjectTarget): number | null {
		return sameGitProject(this.project, project) ? this.contextGeneration : null;
	}

	private isCurrentContext(project: GitProjectTarget, generation: number): boolean {
		return sameGitProject(this.project, project) && this.contextGeneration === generation;
	}
}
