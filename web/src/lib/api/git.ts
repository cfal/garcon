// Typed API client for git operations. All functions require the `project`
// parameter (the project path on disk) to scope operations.

import { apiGet, apiPost } from './client.js';

// Workbench V2 types

export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';

export interface GitTreeNode {
	path: string;
	name: string;
	kind: 'file' | 'directory';
	changeKind?: GitChangeKind;
	staged: boolean;
	hasUnstaged: boolean;
	children?: GitTreeNode[];
	additions?: number;
	deletions?: number;
}

export interface GitDiffRange {
	type: 'equal' | 'insert' | 'delete' | 'replace' | 'skip';
	before: [number, number];
	after: [number, number];
	header?: string;
}

export interface GitHunk {
	id: string;
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lineStartIndex: number;
	lineEndIndex: number;
}

export type GitDiffTab = 'unstaged' | 'staged';

export interface GitFileReviewData {
	path: string;
	isBinary: boolean;
	truncated: boolean;
	truncatedReason?: string;
	contentBefore: string | null;
	contentAfter: string | null;
	diffOps: GitDiffRange[];
	hunks: GitHunk[];
	error?: string;
}

export interface GitReviewCommentDraft {
	id: string;
	filePath: string;
	side: 'before' | 'after';
	line: number;
	lineEnd?: number;
	body: string;
	severity: 'note' | 'warning' | 'blocker';
	createdAt: string;
}

export interface GitWorktreeItem {
	name: string;
	path: string;
	branch: string;
	isCurrent: boolean;
	isMain: boolean;
	isPathMissing: boolean;
}

export interface GitStatus {
	branch: string;
	hasCommits: boolean;
	modified: string[];
	added: string[];
	deleted: string[];
	untracked: string[];
	error?: string;
	details?: string;
}

export interface GitRemoteStatus {
	hasRemote: boolean;
	hasUpstream: boolean;
	branch: string;
	remoteName: string | null;
	remoteBranch?: string;
	ahead: number;
	behind: number;
	isUpToDate: boolean;
	message?: string;
	error?: string;
}

export interface GitCommit {
	hash: string;
	author: string;
	email: string;
	date: string;
	message: string;
	stats: string;
}

export interface ConfirmAction {
	type: 'discard' | 'delete' | 'commit' | 'pull' | 'push';
	file?: string;
	message?: string;
}

interface SuccessResponse {
	success: boolean;
	output?: string;
	message?: string;
	error?: string;
	details?: string;
}

function projectParam(project: string): string {
	return `project=${encodeURIComponent(project)}`;
}

export interface GitRepoInfo {
	isGitRepository: boolean;
	repoRoot?: string;
	currentWorktreePath?: string;
}

export async function getGitRepoInfo(project: string): Promise<GitRepoInfo> {
	return apiGet<GitRepoInfo>(`/api/v1/git/repo-info?${projectParam(project)}`);
}

export async function getGitStatus(project: string): Promise<GitStatus> {
	return apiGet<GitStatus>(`/api/v1/git/status?${projectParam(project)}`);
}

export async function getGitDiff(project: string, file: string): Promise<{ diff?: string; error?: string }> {
	return apiGet(`/api/v1/git/diff?${projectParam(project)}&file=${encodeURIComponent(file)}`);
}

export async function getFileWithDiff(
	project: string,
	file: string
): Promise<{ currentContent?: string; oldContent?: string; isDeleted?: boolean; isUntracked?: boolean; error?: string }> {
	return apiGet(`/api/v1/git/file-with-diff?${projectParam(project)}&file=${encodeURIComponent(file)}`);
}

export async function gitCommit(
	project: string,
	message: string,
	files: string[]
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/commit', { project, message, files });
}

export async function gitInitialCommit(project: string): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/initial-commit', { project });
}

export async function getBranches(project: string): Promise<{ branches?: string[]; error?: string }> {
	return apiGet(`/api/v1/git/branches?${projectParam(project)}`);
}

export async function gitCheckout(project: string, branch: string): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/checkout', { project, branch });
}

export async function gitCreateBranch(project: string, branch: string): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/create-branch', { project, branch });
}

export async function getCommitHistory(
	project: string,
	limit = 10
): Promise<{ commits?: GitCommit[]; error?: string }> {
	return apiGet(`/api/v1/git/commits?${projectParam(project)}&limit=${limit}`);
}

export async function getCommitDiff(
	project: string,
	commit: string
): Promise<{ diff?: string; error?: string }> {
	return apiGet(`/api/v1/git/commit-diff?${projectParam(project)}&commit=${encodeURIComponent(commit)}`);
}

export async function generateCommitMessage(
	project: string,
	files: string[],
	provider = 'claude',
	model = '',
	customPrompt = '',
): Promise<{ message?: string; error?: string }> {
	return apiPost('/api/v1/git/generate-commit-message',
		{ project, files, provider, model, customPrompt },
		{ timeoutMs: 120_000 },
	);
}

export async function getRemoteStatus(project: string): Promise<GitRemoteStatus> {
	return apiGet<GitRemoteStatus>(`/api/v1/git/remote-status?${projectParam(project)}`);
}

export async function gitFetch(project: string): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/fetch', { project });
}

export async function gitPull(project: string): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/pull', { project });
}

export async function gitPush(
	project: string,
	remote?: string,
	remoteBranch?: string,
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/push', { project, remote, remoteBranch });
}

export interface GitRemoteEntry {
	name: string;
	url: string;
}

export async function getGitRemotes(
	project: string,
): Promise<{ remotes: GitRemoteEntry[]; error?: string }> {
	return apiGet<{ remotes: GitRemoteEntry[]; error?: string }>(
		`/api/v1/git/remotes?${projectParam(project)}`,
	);
}

export async function gitDiscard(project: string, file: string): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/discard', { project, file });
}

export async function gitDeleteUntracked(project: string, file: string): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/delete-untracked', { project, file });
}

// Workbench V2 API

export async function getGitFileReviewData(
	project: string,
	file: string,
	tab: GitDiffTab,
	context = 5,
): Promise<GitFileReviewData> {
	const mode = tab === 'staged' ? 'staged' : 'working';
	return apiGet<GitFileReviewData>(
		`/api/v1/git/file-review-data?${projectParam(project)}&file=${encodeURIComponent(file)}&mode=${mode}&context=${context}`,
	);
}

export async function getGitChangesTree(project: string): Promise<{ root: GitTreeNode[]; hasCommits: boolean }> {
	return apiGet<{ root: GitTreeNode[]; hasCommits: boolean }>(`/api/v1/git/changes-tree?${projectParam(project)}`);
}

export async function gitStageSelection(
	project: string,
	file: string,
	mode: 'stage' | 'unstage',
	lineIndices: number[],
	contextLines: number,
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/stage-selection', {
		project,
		file,
		mode,
		selection: { lineIndices },
		contextLines,
	});
}

export async function gitStageHunk(
	project: string,
	file: string,
	mode: 'stage' | 'unstage',
	hunkIndex: number,
	contextLines: number,
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/stage-hunk', {
		project,
		file,
		mode,
		hunkIndex,
		contextLines,
	});
}

export async function getGitWorktrees(
	project: string,
): Promise<{ worktrees: GitWorktreeItem[] }> {
	return apiGet<{ worktrees: GitWorktreeItem[] }>(`/api/v1/git/worktrees?${projectParam(project)}`);
}

export async function gitCreateWorktree(
	project: string,
	worktreePath: string,
	options: { baseRef?: string; branch?: string; detach?: boolean } = {},
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/worktrees/create', {
		project,
		worktreePath,
		...options,
	});
}

export async function gitRemoveWorktree(
	project: string,
	worktreePath: string,
	force = false,
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/worktrees/remove', {
		project,
		worktreePath,
		force,
	});
}

export async function gitRevertLastCommit(
	project: string,
	strategy: 'revert' | 'reset-soft' = 'revert',
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/revert-last-commit', {
		project,
		strategy,
	});
}

export async function gitCommitIndex(
	project: string,
	message: string,
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/commit-index', {
		project,
		message,
	});
}

export async function gitStageFile(
	project: string,
	file: string,
	mode: 'stage' | 'unstage',
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/stage-file', {
		project,
		file,
		mode,
	});
}
