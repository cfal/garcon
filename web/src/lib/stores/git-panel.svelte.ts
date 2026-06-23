// Reactive store for the git source-control panel. Owns all git state,
// API interactions, and action handlers so the component remains a thin
// rendering shell.

import * as m from '$lib/paraglide/messages.js';
import {
	type GitStatus,
	type GitRemoteStatus,
	type ConfirmAction,
	type GitRemoteEntry,
	getGitStatus,
	getBranches as fetchBranchesApi,
	getRemoteStatus as fetchRemoteStatusApi,
	getGitRemotes,
	gitCommit,
	gitInitialCommit,
	gitCheckout,
	gitCreateBranch,
	gitFetch,
	gitPull,
	gitPush,
	gitDiscard,
	gitDeleteUntracked,
} from '$lib/api/git.js';

const EMPTY_STATUS: GitStatus = {
	branch: '',
	hasCommits: false,
	modified: [],
	added: [],
	deleted: [],
	untracked: [],
};

export class GitPanelStore {
	// Git state
	gitStatus = $state<GitStatus | null>(null);
	gitDiffMap = $state<Record<string, string>>({});
	isLoading = $state(false);
	commitMessage = $state('');
	expandedFiles = $state(new Set<string>());
	selectedFiles = $state(new Set<string>());
	isCommitting = $state(false);
	currentBranch = $state('');
	branches = $state<string[]>([]);
	isLoadingBranches = $state(false);
	wrapText = $state(true);
	showLegend = $state(false);
	showBranchDropdown = $state(false);
	showNewBranchModal = $state(false);
	newBranchName = $state('');
	isCreatingBranch = $state(false);
	activeView = $state<'changes' | 'history'>('changes');
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
	private remoteStatusGeneration = 0;

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

	async fetchGitStatus(projectPath: string): Promise<void> {
		this.isLoading = true;
		try {
			const data = await getGitStatus(projectPath);
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
			this.surfaceError(`Git status failed: ${err instanceof Error ? err.message : String(err)}`);
			this.gitStatus = {
				...EMPTY_STATUS,
				error: 'Git operation failed',
				details: String(err),
			};
			this.currentBranch = '';
			this.selectedFiles = new Set();
		} finally {
			this.isLoading = false;
		}
	}

	async fetchBranches(projectPath: string): Promise<void> {
		this.isLoadingBranches = true;
		try {
			const data = await fetchBranchesApi(projectPath);
			this.branches = !data.error && data.branches ? data.branches : [];
		} catch (err) {
			console.error('[Git] Error fetching branches:', err);
			this.branches = [];
		} finally {
			this.isLoadingBranches = false;
		}
	}

	async fetchRemoteStatus(projectPath: string): Promise<void> {
		const generation = ++this.remoteStatusGeneration;
		try {
			const data = await fetchRemoteStatusApi(projectPath);
			if (generation !== this.remoteStatusGeneration) return;
			this.remoteStatus = !data.error ? data : null;
			if (!this.currentBranch && !data.error && data.branch) this.currentBranch = data.branch;
		} catch (err) {
			if (generation !== this.remoteStatusGeneration) return;
			console.error('[Git] Error fetching remote status:', err);
			this.remoteStatus = null;
		}
	}

	refreshAll(projectPath: string): void {
		this.fetchGitStatus(projectPath);
		this.fetchBranches(projectPath);
		this.fetchRemoteStatus(projectPath);
	}

	refreshDeferredMetadata(projectPath: string): void {
		this.fetchBranches(projectPath);
		this.fetchRemoteStatus(projectPath);
	}

	// Resets transient state when the project path changes.
	resetForProject(
		projectPath: string | null,
		options: { deferMetadata?: boolean; currentBranch?: string } = {},
	): void {
		this.remoteStatusGeneration += 1;
		this.currentBranch = options.currentBranch ?? '';
		this.branches = [];
		this.gitStatus = null;
		this.remoteStatus = null;
		this.selectedFiles = new Set();
		if (!projectPath) return;
		if (options.deferMetadata) return;
		this.refreshAll(projectPath);
	}

	async openBranchDropdown(projectPath: string): Promise<void> {
		this.showBranchDropdown = true;
		if (this.branches.length === 0 && !this.isLoadingBranches) {
			await this.fetchBranches(projectPath);
		}
	}

	// Remote action helper that refreshes status after completion.
	private async postGitAction(
		projectPath: string,
		action: () => Promise<{ success?: boolean; error?: string }>,
		setLoading: (v: boolean) => void,
	): Promise<boolean> {
		setLoading(true);
		try {
			const data = await action();
			if (data.success) {
				await Promise.all([this.fetchGitStatus(projectPath), this.fetchRemoteStatus(projectPath)]);
				return true;
			}
			this.surfaceError(data.error ?? 'Git action failed');
			return false;
		} catch (err) {
			this.surfaceError(`Git action failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		} finally {
			setLoading(false);
		}
	}

	// Git actions

	handleFetch(projectPath: string): Promise<boolean> {
		return this.postGitAction(
			projectPath,
			() => gitFetch(projectPath),
			(v) => (this.isFetching = v),
		);
	}

	handlePull(projectPath: string): Promise<boolean> {
		return this.postGitAction(
			projectPath,
			() => gitPull(projectPath),
			(v) => (this.isPulling = v),
		);
	}

	handlePush(projectPath: string, remote?: string, remoteBranch?: string): Promise<boolean> {
		this.showPushModal = false;
		return this.postGitAction(
			projectPath,
			() => gitPush(projectPath, remote, remoteBranch),
			(v) => (this.isPushing = v),
		);
	}

	// Opens the push modal after fetching available remotes.
	async handleToolbarPush(projectPath: string): Promise<void> {
		if (!this.remoteStatus?.hasRemote) return;

		try {
			const data = await getGitRemotes(projectPath);
			this.pushRemotes = data.remotes ?? [];
		} catch {
			this.pushRemotes = [];
		}

		if (this.pushRemotes.length === 0) return;
		this.showPushModal = true;
	}

	async handleSwitchBranch(projectPath: string, branch: string): Promise<boolean> {
		try {
			const data = await gitCheckout(projectPath, branch);
			if (data.success) {
				this.currentBranch = branch;
				this.showBranchDropdown = false;
				await Promise.all([
					this.fetchGitStatus(projectPath),
					this.fetchBranches(projectPath),
					this.fetchRemoteStatus(projectPath),
				]);
				return true;
			}
			this.surfaceError(data.error ?? 'Switch branch failed');
			return false;
		} catch (err) {
			this.surfaceError(
				`Switch branch failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	async handleCreateBranch(projectPath: string): Promise<boolean> {
		if (!this.newBranchName.trim()) return false;
		this.isCreatingBranch = true;
		try {
			const data = await gitCreateBranch(projectPath, this.newBranchName.trim());
			if (data.success) {
				this.currentBranch = this.newBranchName.trim();
				this.showNewBranchModal = false;
				this.showBranchDropdown = false;
				this.newBranchName = '';
				await Promise.all([
					this.fetchBranches(projectPath),
					this.fetchGitStatus(projectPath),
					this.fetchRemoteStatus(projectPath),
				]);
				return true;
			}
			this.surfaceError(data.error ?? 'Create branch failed');
			return false;
		} catch (err) {
			this.surfaceError(
				`Create branch failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		} finally {
			this.isCreatingBranch = false;
		}
	}

	async handleCommit(projectPath: string): Promise<boolean> {
		if (!this.commitMessage.trim() || this.selectedFiles.size === 0) return false;
		this.isCommitting = true;
		try {
			const data = await gitCommit(projectPath, this.commitMessage, Array.from(this.selectedFiles));
			if (data.success) {
				this.commitMessage = '';
				this.selectedFiles = new Set();
				this.fetchGitStatus(projectPath);
				this.fetchRemoteStatus(projectPath);
				return true;
			} else {
				this.surfaceError(data.error ?? 'Commit failed');
				return false;
			}
		} catch (err) {
			this.surfaceError(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		} finally {
			this.isCommitting = false;
		}
	}

	async handleCreateInitialCommit(projectPath: string): Promise<boolean> {
		this.isCreatingInitialCommit = true;
		try {
			const data = await gitInitialCommit(projectPath);
			if (data.success) {
				this.fetchGitStatus(projectPath);
				this.fetchRemoteStatus(projectPath);
				return true;
			} else {
				this.surfaceError(data.error ?? 'Initial commit failed');
				return false;
			}
		} catch (err) {
			this.surfaceError(
				`Initial commit failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		} finally {
			this.isCreatingInitialCommit = false;
		}
	}

	async handleDiscardChanges(projectPath: string, filePath: string): Promise<boolean> {
		try {
			const data = await gitDiscard(projectPath, filePath);
			if (data.success) {
				const next = new Set(this.selectedFiles);
				next.delete(filePath);
				this.selectedFiles = next;
				this.fetchGitStatus(projectPath);
				return true;
			} else {
				this.surfaceError(data.error ?? 'Discard failed');
				return false;
			}
		} catch (err) {
			this.surfaceError(`Discard failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	async handleDeleteUntracked(projectPath: string, filePath: string): Promise<boolean> {
		try {
			const data = await gitDeleteUntracked(projectPath, filePath);
			if (data.success) {
				const next = new Set(this.selectedFiles);
				next.delete(filePath);
				this.selectedFiles = next;
				this.fetchGitStatus(projectPath);
				return true;
			} else {
				this.surfaceError(data.error ?? 'Delete failed');
				return false;
			}
		} catch (err) {
			this.surfaceError(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	// Dispatches the pending confirm action and clears it.
	async confirmAndExecute(projectPath: string): Promise<boolean> {
		if (!this.confirmAction) return false;
		const { type, file } = this.confirmAction;
		this.confirmAction = null;
		switch (type) {
			case 'discard':
				return file ? this.handleDiscardChanges(projectPath, file) : false;
			case 'delete':
				return file ? this.handleDeleteUntracked(projectPath, file) : false;
			case 'commit':
				return this.handleCommit(projectPath);
			case 'pull':
				return this.handlePull(projectPath);
			case 'push':
				return this.handlePush(projectPath);
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
}

export function createGitPanelStore(): GitPanelStore {
	return new GitPanelStore();
}
