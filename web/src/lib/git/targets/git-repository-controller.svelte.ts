import type { GitProjectTarget } from '$lib/api/git-client.js';
import { sameGitProject } from './git-target.js';
// Owns repository status, branch and remote metadata, and repository actions
// used by the Git surface.

import * as m from '$lib/paraglide/messages.js';
import {
	type GitStatus,
	type GitRemoteStatus,
	type ConfirmAction,
	type GitRemoteEntry,
	type GitRefKind,
	type GitRefOption,
	getGitStatus,
	getRemoteStatus as fetchRemoteStatusApi,
	getGitRemotes,
	gitCommit,
	gitInitialCommit,
	gitFetch,
	gitPull,
	gitPush,
	gitDiscard,
	gitDeleteUntracked,
} from '$lib/api/git.js';
import { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';

export interface GitRepositoryControllerOptions {
	branches: GitBranchSelectorState;
	surfaceId: string;
}

const EMPTY_STATUS: GitStatus = {
	branch: '',
	hasCommits: false,
	modified: [],
	added: [],
	deleted: [],
	untracked: [],
};

export class GitRepositoryController {
	// Git state
	gitStatus = $state<GitStatus | null>(null);
	gitDiffMap = $state<Record<string, string>>({});
	isLoading = $state(false);
	commitMessage = $state('');
	expandedFiles = $state(new Set<string>());
	selectedFiles = $state(new Set<string>());
	isCommitting = $state(false);
	wrapText = $state(true);
	showLegend = $state(false);
	remoteStatus = $state<GitRemoteStatus | null>(null);
	isFetching = $state(false);
	isPulling = $state(false);
	isPushing = $state(false);
	showPushModal = $state(false);
	pushRemotes = $state<GitRemoteEntry[]>([]);
	isCommitAreaCollapsed = $state(false);
	confirmAction = $state<ConfirmAction | null>(null);
	isCreatingInitialCommit = $state(false);
	lastError = $state<string | null>(null);
	private contextGeneration = 0;
	private project: GitProjectTarget | null = null;
	private statusGeneration = 0;
	private remoteStatusGeneration = 0;
	private readonly branchSelector: GitBranchSelectorState;
	private readonly surfaceId: string;

	constructor(options: GitRepositoryControllerOptions) {
		this.branchSelector = options.branches;
		this.surfaceId = options.surfaceId;
	}

	get currentBranch(): string {
		return this.branchSelector.currentBranch;
	}

	set currentBranch(value: string) {
		this.branchSelector.currentBranch = value;
	}

	get branches(): string[] {
		return this.branchSelector.branches;
	}

	set branches(value: string[]) {
		this.branchSelector.branches = value;
	}

	get refs(): GitRefOption[] {
		return this.branchSelector.refs;
	}

	set refs(value: GitRefOption[]) {
		this.branchSelector.refs = value;
	}

	get isLoadingBranches(): boolean {
		return this.branchSelector.isLoadingBranches;
	}

	set isLoadingBranches(value: boolean) {
		this.branchSelector.isLoadingBranches = value;
	}

	get showBranchDropdown(): boolean {
		return this.branchSelector.showBranchDropdown;
	}

	set showBranchDropdown(value: boolean) {
		this.branchSelector.showBranchDropdown = value;
	}

	openNewBranchDialog(project: GitProjectTarget, effectiveProjectKey: string): void {
		this.branchSelector.openNewBranchDialog(
			project.projectPath,
			this.surfaceId,
			effectiveProjectKey,
		);
	}

	// Data fetching

	surfaceError(message: string): void {
		this.lastError = message;
		setTimeout(() => {
			if (this.lastError === message) this.lastError = null;
		}, 6000);
	}

	dismissError(): void {
		this.lastError = null;
	}

	async fetchGitStatus(project: GitProjectTarget): Promise<void> {
		const contextGeneration = this.captureContext(project);
		if (contextGeneration === null) return;
		const requestGeneration = ++this.statusGeneration;
		this.isLoading = true;
		try {
			const data = await getGitStatus(project);
			if (
				!this.isCurrentContext(project, contextGeneration) ||
				requestGeneration !== this.statusGeneration
			)
				return;
			if (data.error) {
				this.gitStatus = { ...EMPTY_STATUS, error: data.error, details: data.details };
				this.currentBranch = '';
				this.selectedFiles = new Set();
			} else {
				this.gitStatus = data;
				this.currentBranch = data.branch || 'main';
				this.selectedFiles = new Set();
			}
		} catch (err) {
			if (
				!this.isCurrentContext(project, contextGeneration) ||
				requestGeneration !== this.statusGeneration
			)
				return;
			this.surfaceError(`Git status failed: ${err instanceof Error ? err.message : String(err)}`);
			this.gitStatus = {
				...EMPTY_STATUS,
				error: 'Git operation failed',
				details: String(err),
			};
			this.currentBranch = '';
			this.selectedFiles = new Set();
		} finally {
			if (
				this.isCurrentContext(project, contextGeneration) &&
				requestGeneration === this.statusGeneration
			) {
				this.isLoading = false;
			}
		}
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
			if (!this.currentBranch && !data.error && data.branch) this.currentBranch = data.branch;
		} catch (err) {
			if (
				generation !== this.remoteStatusGeneration ||
				!this.isCurrentContext(project, contextGeneration)
			)
				return;
			console.error('[Git] Error fetching remote status:', err);
			this.remoteStatus = null;
		}
	}

	refreshAll(project: GitProjectTarget): void {
		this.fetchGitStatus(project);
		this.fetchRemoteStatus(project);
	}

	refreshDeferredMetadata(project: GitProjectTarget): void {
		this.fetchRemoteStatus(project);
	}

	suspend(): void {
		this.contextGeneration++;
		this.statusGeneration++;
		this.remoteStatusGeneration++;
		this.isLoading = false;
		this.isFetching = false;
		this.isPulling = false;
		this.isPushing = false;
		this.showPushModal = false;
		this.confirmAction = null;
	}

	// Resets transient state when the project path changes.
	resetForProject(
		project: GitProjectTarget | null,
		options: {
			deferMetadata?: boolean;
			currentBranch?: string;
			effectiveProjectKey?: string | null;
		} = {},
	): void {
		this.contextGeneration += 1;
		this.project = project;
		this.statusGeneration += 1;
		this.remoteStatusGeneration += 1;
		this.gitStatus = null;
		this.remoteStatus = null;
		this.commitMessage = '';
		this.expandedFiles = new Set();
		this.selectedFiles = new Set();
		this.confirmAction = null;
		this.showPushModal = false;
		this.pushRemotes = [];
		this.lastError = null;
		this.isLoading = false;
		this.isCommitting = false;
		this.isCreatingInitialCommit = false;
		this.isFetching = false;
		this.isPulling = false;
		this.isPushing = false;
		if (!project) return;
		if (options.deferMetadata) return;
		this.refreshAll(project);
	}

	async openBranchDropdown(project: GitProjectTarget): Promise<void> {
		await this.branchSelector.openBranchDropdown(project.projectPath);
	}

	// Remote action helper that refreshes status after completion.
	private async postGitAction(
		project: GitProjectTarget,
		action: () => Promise<{ success?: boolean; error?: string }>,
		setLoading: (v: boolean) => void,
	): Promise<boolean> {
		const contextGeneration = this.captureContext(project);
		if (contextGeneration === null) return false;
		setLoading(true);
		try {
			const data = await action();
			if (!this.isCurrentContext(project, contextGeneration)) return Boolean(data.success);
			if (data.success) {
				await Promise.all([this.fetchGitStatus(project), this.fetchRemoteStatus(project)]);
				return true;
			}
			this.surfaceError(data.error ?? 'Git action failed');
			return false;
		} catch (err) {
			if (this.isCurrentContext(project, contextGeneration)) {
				this.surfaceError(`Git action failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return false;
		} finally {
			if (this.isCurrentContext(project, contextGeneration)) setLoading(false);
		}
	}

	// Git actions

	handleFetch(project: GitProjectTarget): Promise<boolean> {
		return this.postGitAction(
			project,
			() => gitFetch(project),
			(v) => (this.isFetching = v),
		);
	}

	handlePull(project: GitProjectTarget): Promise<boolean> {
		return this.postGitAction(
			project,
			() => gitPull(project),
			(v) => (this.isPulling = v),
		);
	}

	handlePush(project: GitProjectTarget, remote?: string): Promise<boolean> {
		if (this.captureContext(project) === null) return Promise.resolve(false);
		this.showPushModal = false;
		return this.postGitAction(
			project,
			() => gitPush(project, remote),
			(v) => (this.isPushing = v),
		);
	}

	async prepareToolbarPush(project: GitProjectTarget): Promise<boolean> {
		const contextGeneration = this.captureContext(project);
		if (contextGeneration === null) return false;
		if (!this.remoteStatus?.hasRemote) return false;

		try {
			const data = await getGitRemotes(project);
			if (!this.isCurrentContext(project, contextGeneration)) return false;
			this.pushRemotes = data.remotes ?? [];
		} catch {
			if (!this.isCurrentContext(project, contextGeneration)) return false;
			this.pushRemotes = [];
		}

		return this.pushRemotes.length > 0;
	}

	async handleSwitchBranch(
		project: GitProjectTarget,
		branch: string,
		refKind: GitRefKind | undefined,
		effectiveProjectKey: string,
	): Promise<boolean> {
		const ok = await this.branchSelector.switchBranch(
			project.projectPath,
			branch,
			refKind,
			this.surfaceId,
			effectiveProjectKey,
		);
		if (ok) await Promise.all([this.fetchGitStatus(project), this.fetchRemoteStatus(project)]);
		return ok;
	}

	async handleCommit(project: GitProjectTarget): Promise<boolean> {
		const contextGeneration = this.captureContext(project);
		if (contextGeneration === null) return false;
		if (!this.commitMessage.trim() || this.selectedFiles.size === 0) return false;
		this.isCommitting = true;
		try {
			const data = await gitCommit(project, this.commitMessage, Array.from(this.selectedFiles));
			if (!this.isCurrentContext(project, contextGeneration)) return Boolean(data.success);
			if (data.success) {
				this.commitMessage = '';
				this.selectedFiles = new Set();
				this.fetchGitStatus(project);
				this.fetchRemoteStatus(project);
				return true;
			} else {
				this.surfaceError(data.error ?? 'Commit failed');
				return false;
			}
		} catch (err) {
			if (this.isCurrentContext(project, contextGeneration)) {
				this.surfaceError(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return false;
		} finally {
			if (this.isCurrentContext(project, contextGeneration)) this.isCommitting = false;
		}
	}

	async handleCreateInitialCommit(project: GitProjectTarget): Promise<boolean> {
		const contextGeneration = this.captureContext(project);
		if (contextGeneration === null) return false;
		this.isCreatingInitialCommit = true;
		try {
			const data = await gitInitialCommit(project);
			if (!this.isCurrentContext(project, contextGeneration)) return Boolean(data.success);
			if (data.success) {
				this.fetchGitStatus(project);
				this.fetchRemoteStatus(project);
				return true;
			} else {
				this.surfaceError(data.error ?? 'Initial commit failed');
				return false;
			}
		} catch (err) {
			if (this.isCurrentContext(project, contextGeneration)) {
				this.surfaceError(
					`Initial commit failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return false;
		} finally {
			if (this.isCurrentContext(project, contextGeneration)) this.isCreatingInitialCommit = false;
		}
	}

	async handleDiscardChanges(project: GitProjectTarget, filePath: string): Promise<boolean> {
		const contextGeneration = this.captureContext(project);
		if (contextGeneration === null) return false;
		try {
			const data = await gitDiscard(project, filePath);
			if (!this.isCurrentContext(project, contextGeneration)) return Boolean(data.success);
			if (data.success) {
				const next = new Set(this.selectedFiles);
				next.delete(filePath);
				this.selectedFiles = next;
				this.fetchGitStatus(project);
				return true;
			} else {
				this.surfaceError(data.error ?? 'Discard failed');
				return false;
			}
		} catch (err) {
			if (this.isCurrentContext(project, contextGeneration)) {
				this.surfaceError(`Discard failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return false;
		}
	}

	async handleDeleteUntracked(project: GitProjectTarget, filePath: string): Promise<boolean> {
		const contextGeneration = this.captureContext(project);
		if (contextGeneration === null) return false;
		try {
			const data = await gitDeleteUntracked(project, filePath);
			if (!this.isCurrentContext(project, contextGeneration)) return Boolean(data.success);
			if (data.success) {
				const next = new Set(this.selectedFiles);
				next.delete(filePath);
				this.selectedFiles = next;
				this.fetchGitStatus(project);
				return true;
			} else {
				this.surfaceError(data.error ?? 'Delete failed');
				return false;
			}
		} catch (err) {
			if (this.isCurrentContext(project, contextGeneration)) {
				this.surfaceError(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return false;
		}
	}

	// Dispatches the pending confirm action and clears it.
	async confirmAndExecute(project: GitProjectTarget): Promise<boolean> {
		if (!this.confirmAction) return false;
		const { type, file } = this.confirmAction;
		this.confirmAction = null;
		switch (type) {
			case 'discard':
				return file ? this.handleDiscardChanges(project, file) : false;
			case 'delete':
				return file ? this.handleDeleteUntracked(project, file) : false;
			case 'commit':
				return this.handleCommit(project);
			case 'pull':
				return this.handlePull(project);
			case 'push':
				return this.handlePush(project);
		}
		return false;
	}

	// Toggle helpers

	toggleFileExpanded(path: string): void {
		const next = new Set(this.expandedFiles);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		this.expandedFiles = next;
	}

	toggleFileSelected(path: string): void {
		const next = new Set(this.selectedFiles);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		this.selectedFiles = next;
	}

	selectAllFiles(): void {
		if (!this.gitStatus) return;
		this.selectedFiles = new Set<string>([
			...(this.gitStatus.modified ?? []),
			...(this.gitStatus.added ?? []),
			...(this.gitStatus.deleted ?? []),
			...(this.gitStatus.untracked ?? []),
		]);
	}

	deselectAllFiles(): void {
		this.selectedFiles = new Set();
	}

	// Presentation helper passed down to child components.
	getStatusLabel(status: string): string {
		switch (status) {
			case 'M':
				return m.git_changes_modified();
			case 'A':
				return m.git_changes_added();
			case 'D':
				return m.git_changes_deleted();
			case 'U':
				return m.git_changes_untracked();
			default:
				return status;
		}
	}

	private captureContext(project: GitProjectTarget): number | null {
		return sameGitProject(this.project, project) ? this.contextGeneration : null;
	}

	private isCurrentContext(project: GitProjectTarget, generation: number): boolean {
		return sameGitProject(this.project, project) && this.contextGeneration === generation;
	}
}
