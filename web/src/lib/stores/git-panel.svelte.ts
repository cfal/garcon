// Reactive store for the git source-control panel. Owns all git state,
// API interactions, and action handlers so the component remains a thin
// rendering shell.

import * as m from '$lib/paraglide/messages.js';
import {
	type GitStatus,
	type GitRemoteStatus,
	type GitCommit,
	type ConfirmAction,
	type GitRemoteEntry,
	getGitStatus,
	getGitDiff,
	getBranches as fetchBranchesApi,
	getRemoteStatus as fetchRemoteStatusApi,
	getGitRemotes,
	getCommitHistory,
	getCommitDiff,
	generateCommitMessage as generateCommitMessageApi,
	gitCommit,
	gitInitialCommit,
	gitCheckout,
	gitCreateBranch,
	gitFetch,
	gitPull,
	gitPush,
	gitDiscard,
	gitDeleteUntracked
} from '$lib/api/git.js';

const EMPTY_STATUS: GitStatus = {
	branch: '',
	hasCommits: false,
	modified: [],
	added: [],
	deleted: [],
	untracked: []
};

export interface GitPanelStoreOptions {
	/** Reactive getter for the active provider name. */
	get provider(): string;
}

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
	wrapText = $state(true);
	showLegend = $state(false);
	showBranchDropdown = $state(false);
	showNewBranchModal = $state(false);
	newBranchName = $state('');
	isCreatingBranch = $state(false);
	activeView = $state<'changes' | 'history'>('changes');
	recentCommits = $state<GitCommit[]>([]);
	expandedCommits = $state(new Set<string>());
	commitDiffs = $state<Record<string, string>>({});
	isGeneratingMessage = $state(false);
	remoteStatus = $state<GitRemoteStatus | null>(null);
	isFetching = $state(false);
	isPulling = $state(false);
	isPushing = $state(false);
	showPushModal = $state(false);
	pushRemotes = $state<GitRemoteEntry[]>([]);
	isCommitAreaCollapsed = $state(false);
	confirmAction = $state<ConfirmAction | null>(null);
	isCreatingInitialCommit = $state(false);

	private readonly opts: GitPanelStoreOptions;

	constructor(opts?: GitPanelStoreOptions) {
		this.opts = opts ?? { get provider() { return 'claude'; } };
	}

	private get provider(): string {
		return this.opts.provider;
	}

	// Data fetching

	private async fetchFileDiff(projectPath: string, file: string): Promise<void> {
		try {
			const data = await getGitDiff(projectPath, file);
			if (!data.error && data.diff) {
				this.gitDiffMap = { ...this.gitDiffMap, [file]: data.diff };
			}
		} catch (err) {
			console.error('[Git] Error fetching file diff:', err);
		}
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
				const allFiles = [
					...(data.modified ?? []),
					...(data.added ?? []),
					...(data.deleted ?? []),
					...(data.untracked ?? [])
				];
				for (const file of allFiles) this.fetchFileDiff(projectPath, file);
			}
		} catch (err) {
			console.error('[Git] Error fetching status:', err);
			this.gitStatus = {
				...EMPTY_STATUS,
				error: 'Git operation failed',
				details: String(err)
			};
			this.currentBranch = '';
			this.selectedFiles = new Set();
		} finally {
			this.isLoading = false;
		}
	}

	async fetchBranches(projectPath: string): Promise<void> {
		try {
			const data = await fetchBranchesApi(projectPath);
			this.branches = !data.error && data.branches ? data.branches : [];
		} catch (err) {
			console.error('[Git] Error fetching branches:', err);
			this.branches = [];
		}
	}

	async fetchRemoteStatus(projectPath: string): Promise<void> {
		try {
			const data = await fetchRemoteStatusApi(projectPath);
			this.remoteStatus = !data.error ? data : null;
		} catch (err) {
			console.error('[Git] Error fetching remote status:', err);
			this.remoteStatus = null;
		}
	}

	async fetchRecentCommits(projectPath: string): Promise<void> {
		try {
			const data = await getCommitHistory(projectPath, 10);
			if (!data.error && data.commits) this.recentCommits = data.commits;
		} catch (err) {
			console.error('[Git] Error fetching commits:', err);
		}
	}

	private async fetchCommitDiffData(projectPath: string, hash: string): Promise<void> {
		try {
			const data = await getCommitDiff(projectPath, hash);
			if (!data.error && data.diff) {
				this.commitDiffs = { ...this.commitDiffs, [hash]: data.diff };
			}
		} catch (err) {
			console.error('[Git] Error fetching commit diff:', err);
		}
	}

	refreshAll(projectPath: string): void {
		this.fetchGitStatus(projectPath);
		this.fetchBranches(projectPath);
		this.fetchRemoteStatus(projectPath);
	}

	// Resets transient state when the project path changes.
	resetForProject(projectPath: string | null): void {
		this.currentBranch = '';
		this.branches = [];
		this.gitStatus = null;
		this.remoteStatus = null;
		this.selectedFiles = new Set();
		if (projectPath) this.refreshAll(projectPath);
	}

	// Remote action helper that refreshes status after completion.
	private async postGitAction(
		projectPath: string,
		action: () => Promise<{ success?: boolean; error?: string }>,
		setLoading: (v: boolean) => void
	): Promise<void> {
		setLoading(true);
		try {
			const data = await action();
			if (data.success) {
				this.fetchGitStatus(projectPath);
				this.fetchRemoteStatus(projectPath);
			} else {
				console.error('[Git] Action failed:', data.error);
			}
		} catch (err) {
			console.error('[Git] Action error:', err);
		} finally {
			setLoading(false);
		}
	}

	// Git actions

	handleFetch(projectPath: string): void {
		this.postGitAction(
			projectPath,
			() => gitFetch(projectPath),
			(v) => (this.isFetching = v)
		);
	}

	handlePull(projectPath: string): void {
		this.postGitAction(
			projectPath,
			() => gitPull(projectPath),
			(v) => (this.isPulling = v)
		);
	}

	handlePush(projectPath: string, remote?: string, remoteBranch?: string): void {
		this.showPushModal = false;
		this.postGitAction(
			projectPath,
			() => gitPush(projectPath, remote, remoteBranch),
			(v) => (this.isPushing = v)
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

	async handleSwitchBranch(projectPath: string, branch: string): Promise<void> {
		try {
			const data = await gitCheckout(projectPath, branch);
			if (data.success) {
				this.currentBranch = branch;
				this.showBranchDropdown = false;
				this.fetchGitStatus(projectPath);
			} else {
				console.error('[Git] Switch branch failed:', data.error);
			}
		} catch (err) {
			console.error('[Git] Error switching branch:', err);
		}
	}

	async handleCreateBranch(projectPath: string): Promise<void> {
		if (!this.newBranchName.trim()) return;
		this.isCreatingBranch = true;
		try {
			const data = await gitCreateBranch(projectPath, this.newBranchName.trim());
			if (data.success) {
				this.currentBranch = this.newBranchName.trim();
				this.showNewBranchModal = false;
				this.showBranchDropdown = false;
				this.newBranchName = '';
				this.fetchBranches(projectPath);
				this.fetchGitStatus(projectPath);
			} else {
				console.error('[Git] Create branch failed:', data.error);
			}
		} catch (err) {
			console.error('[Git] Error creating branch:', err);
		} finally {
			this.isCreatingBranch = false;
		}
	}

	async handleCommit(projectPath: string): Promise<void> {
		if (!this.commitMessage.trim() || this.selectedFiles.size === 0) return;
		this.isCommitting = true;
		try {
			const data = await gitCommit(projectPath, this.commitMessage, Array.from(this.selectedFiles));
			if (data.success) {
				this.commitMessage = '';
				this.selectedFiles = new Set();
				this.fetchGitStatus(projectPath);
				this.fetchRemoteStatus(projectPath);
			} else {
				console.error('[Git] Commit failed:', data.error);
			}
		} catch (err) {
			console.error('[Git] Error committing:', err);
		} finally {
			this.isCommitting = false;
		}
	}

	async handleCreateInitialCommit(projectPath: string): Promise<void> {
		this.isCreatingInitialCommit = true;
		try {
			const data = await gitInitialCommit(projectPath);
			if (data.success) {
				this.fetchGitStatus(projectPath);
				this.fetchRemoteStatus(projectPath);
			} else {
				console.error('[Git] Initial commit failed:', data.error);
			}
		} catch (err) {
			console.error('[Git] Error creating initial commit:', err);
		} finally {
			this.isCreatingInitialCommit = false;
		}
	}

	async handleGenerateCommitMessage(projectPath: string): Promise<void> {
		this.isGeneratingMessage = true;
		try {
			const data = await generateCommitMessageApi(
				projectPath,
				Array.from(this.selectedFiles),
				this.provider
			);
			if (data.message) this.commitMessage = data.message;
			else console.error('[Git] Failed to generate message:', data.error);
		} catch (err) {
			console.error('[Git] Error generating commit message:', err);
		} finally {
			this.isGeneratingMessage = false;
		}
	}

	async handleDiscardChanges(projectPath: string, filePath: string): Promise<void> {
		try {
			const data = await gitDiscard(projectPath, filePath);
			if (data.success) {
				const next = new Set(this.selectedFiles);
				next.delete(filePath);
				this.selectedFiles = next;
				this.fetchGitStatus(projectPath);
			} else {
				console.error('[Git] Discard failed:', data.error);
			}
		} catch (err) {
			console.error('[Git] Error discarding:', err);
		}
	}

	async handleDeleteUntracked(projectPath: string, filePath: string): Promise<void> {
		try {
			const data = await gitDeleteUntracked(projectPath, filePath);
			if (data.success) {
				const next = new Set(this.selectedFiles);
				next.delete(filePath);
				this.selectedFiles = next;
				this.fetchGitStatus(projectPath);
			} else {
				console.error('[Git] Delete failed:', data.error);
			}
		} catch (err) {
			console.error('[Git] Error deleting untracked:', err);
		}
	}

	// Dispatches the pending confirm action and clears it.
	async confirmAndExecute(projectPath: string): Promise<void> {
		if (!this.confirmAction) return;
		const { type, file } = this.confirmAction;
		this.confirmAction = null;
		switch (type) {
			case 'discard':
				if (file) await this.handleDiscardChanges(projectPath, file);
				break;
			case 'delete':
				if (file) await this.handleDeleteUntracked(projectPath, file);
				break;
			case 'commit':
				await this.handleCommit(projectPath);
				break;
			case 'pull':
				await this.handlePull(projectPath);
				break;
			case 'push':
				await this.handlePush(projectPath);
				break;
		}
	}

	// Toggle helpers

	toggleFileExpanded(path: string): void {
		const next = new Set(this.expandedFiles);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		this.expandedFiles = next;
	}

	toggleCommitExpanded(projectPath: string, hash: string): void {
		const next = new Set(this.expandedCommits);
		if (next.has(hash)) {
			next.delete(hash);
		} else {
			next.add(hash);
			if (!this.commitDiffs[hash]) this.fetchCommitDiffData(projectPath, hash);
		}
		this.expandedCommits = next;
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
			...(this.gitStatus.untracked ?? [])
		]);
	}

	deselectAllFiles(): void {
		this.selectedFiles = new Set();
	}

	// Presentation helper passed down to child components.
	getStatusLabel(status: string): string {
		switch (status) {
			case 'M': return m.git_changes_modified();
			case 'A': return m.git_changes_added();
			case 'D': return m.git_changes_deleted();
			case 'U': return m.git_changes_untracked();
			default: return status;
		}
	}
}

export function createGitPanelStore(opts?: GitPanelStoreOptions): GitPanelStore {
	return new GitPanelStore(opts);
}
