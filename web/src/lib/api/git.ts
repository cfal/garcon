// Typed API client for git operations. All functions require the `project`
// parameter (the project path on disk) to scope operations.

import { apiGet, apiPost, type ApiFetchOptions } from './client.js';

// Workbench contract types

export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
export type GitStatusCode = ' ' | 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?' | '!';
export type GitFileReviewCategory = 'normal' | 'generated' | 'lockfile' | 'binary' | 'large';
export type GitStageMode = 'stage' | 'unstage';
export const GIT_FRESHNESS_POLL_MS = 15_000;
export const GIT_WORKING_TREE_FINGERPRINT_VERSION = 1;
export const GIT_QUICK_SUMMARY_FINGERPRINT_VERSION = 1;
export type GitDiffLimitReason =
	'patch-too-large' | 'too-many-rows' | 'line-too-long' | 'binary' | 'unsupported-file-kind';

export interface GitChangeStats {
	additions: number;
	deletions: number;
	isBinary?: boolean;
}

export type GitTreeStatsState = 'pending' | 'loaded';

export interface GitFileChangeFacet {
	status: GitStatusCode;
	changeKind: GitChangeKind;
	stats: GitChangeStats;
	originalPath?: string;
	category?: GitFileReviewCategory;
}

export interface GitTreeNode {
	path: string;
	name: string;
	kind: 'file' | 'directory';
	indexStatus?: GitStatusCode;
	workTreeStatus?: GitStatusCode;
	stagedFacet?: GitFileChangeFacet;
	unstagedFacet?: GitFileChangeFacet;
	changeKind?: GitChangeKind;
	staged: boolean;
	hasUnstaged: boolean;
	children?: GitTreeNode[];
	additions?: number;
	deletions?: number;
	category?: GitFileReviewCategory;
}

export interface GitChangesTreeResult {
	root: GitTreeNode[];
	hasCommits: boolean;
	statsState?: GitTreeStatsState;
}

export type GitDiffTab = 'unstaged' | 'staged';
export type GitFileReviewMode = 'working' | 'staged';
export type GitReviewBodyState =
	'unloaded' | 'loading' | 'loaded' | 'binary' | 'too-large' | 'error';
export type GitReviewLimitReason =
	| 'collection-too-many-files'
	| 'collection-too-many-rows'
	| 'collection-too-many-bytes'
	| 'file-too-many-rows'
	| 'file-too-many-bytes'
	| 'line-too-long'
	| 'binary'
	| 'unsupported-file-kind'
	| 'git-timeout';

export type GitRenderedDiffRowKind = 'hunk' | 'context' | 'add' | 'del';

export interface GitRenderedDiffRow {
	key: string;
	kind: GitRenderedDiffRowKind;
	hunkIndex: number;
	hunkId: string;
	beforeLine: number | null;
	afterLine: number | null;
	text: string;
	diffLineIndex: number;
}

export interface GitRenderedHunk {
	id: string;
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	rowStartIndex: number;
	rowEndIndex: number;
}

export interface GitFileReviewData {
	path: string;
	mode: GitFileReviewMode;
	indexStatus?: GitStatusCode;
	workTreeStatus?: GitStatusCode;
	isBinary: boolean;
	truncated: boolean;
	truncatedReason?: string;
	limitReason?: GitDiffLimitReason;
	category?: GitFileReviewCategory;
	rows: GitRenderedDiffRow[];
	hunks: GitRenderedHunk[];
	error?: string;
}

export interface GitReviewDocumentLimits {
	maxSummaryFiles: number;
	maxBodyBatchFiles: number;
	maxLoadedRows: number;
	maxLoadedPatchBytes: number;
	maxFileRows: number;
	maxFilePatchBytes: number;
	maxLineBytes: number;
	maxContextLines: number;
	bodyConcurrency: number;
}

export interface GitReviewCollectionLimit {
	reason: GitReviewLimitReason;
	message: string;
	visibleFiles: number;
	totalFilesKnown: number;
}

export interface GitReviewFileSummary {
	path: string;
	originalPath?: string;
	indexStatus: GitStatusCode;
	workTreeStatus: GitStatusCode;
	category: GitFileReviewCategory;
	additions: number;
	deletions: number;
	statsKnown?: boolean;
	estimatedRows: number;
	bodyState: GitReviewBodyState;
	bodyFingerprint: string;
	isGenerated: boolean;
	isBinary: boolean;
	isTooLarge: boolean;
	limitReason?: GitReviewLimitReason;
	limitMessage?: string;
}

export interface GitReviewDocumentSummary {
	documentId: string;
	project: string;
	mode: GitFileReviewMode;
	context: number;
	files: GitReviewFileSummary[];
	limits: GitReviewDocumentLimits;
	collectionLimit?: GitReviewCollectionLimit;
}

export interface GitReviewFileBody {
	path: string;
	bodyFingerprint: string;
	bodyState: GitReviewBodyState;
	category: GitFileReviewCategory;
	isBinary: boolean;
	isTooLarge: boolean;
	renderedRowCount: number;
	patchBytes: number;
	rows: GitRenderedDiffRow[];
	hunks: GitRenderedHunk[];
	limitReason?: GitReviewLimitReason;
	limitMessage?: string;
	error?: string;
}

export interface GitReviewFileBodiesResponse {
	documentId: string;
	files: Record<string, GitReviewFileBody>;
	errors: Record<string, string>;
}

export interface GitWorkbenchSnapshotTarget {
	projectPath: string;
	repoRoot: string;
	worktreePath: string;
	label: string;
	branch: string;
	source: 'chat-project' | 'worktree';
}

export interface GitWorkbenchSnapshotReady {
	status: 'ready';
	project: string;
	target: GitWorkbenchSnapshotTarget;
	tree: GitChangesTreeResult & { statsState: 'loaded' };
	reviewSummary: GitReviewDocumentSummary;
	selectedFile: string | null;
	firstBodyCandidates: string[];
	snapshotId: string;
	workbenchFingerprint: string;
}

export interface GitWorkbenchSnapshotNotRepository {
	status: 'not-git-repository';
	project: string;
	target: null;
	tree: null;
	reviewSummary: null;
	selectedFile: null;
	firstBodyCandidates: [];
	message: string;
}

export type GitWorkbenchSnapshotResponse =
	GitWorkbenchSnapshotReady | GitWorkbenchSnapshotNotRepository;

export type GitWorkingTreeFingerprintResponse =
	| GitWorkingTreeFingerprintReady
	| GitWorkingTreeFingerprintNotRepository
	| GitWorkingTreeFingerprintUnknown;

export interface GitWorkingTreeFingerprintReady {
	status: 'ready';
	project: string;
	fingerprintVersion: typeof GIT_WORKING_TREE_FINGERPRINT_VERSION;
	fingerprint: string;
	changedPathCount: number;
}

export interface GitWorkingTreeFingerprintNotRepository {
	status: 'not-git-repository';
	project: string;
	fingerprintVersion: typeof GIT_WORKING_TREE_FINGERPRINT_VERSION;
	fingerprint: null;
	message: string;
}

export interface GitWorkingTreeFingerprintUnknown {
	status: 'unknown';
	project: string;
	fingerprintVersion: typeof GIT_WORKING_TREE_FINGERPRINT_VERSION;
	fingerprint: null;
	message: string;
}

export type GitQuickSummaryResponse =
	GitQuickSummaryReady | GitQuickSummaryNotRepository | GitQuickSummaryUnknown;

export interface GitQuickSummaryReady {
	status: 'ready';
	project: string;
	repoRoot: string;
	branch: string;
	hasCommits: boolean;
	changedFiles: number;
	trackedChangedFiles: number;
	untrackedFiles: number;
	stagedFiles: number;
	unstagedFiles: number;
	additions: number;
	deletions: number;
	fingerprintVersion: typeof GIT_QUICK_SUMMARY_FINGERPRINT_VERSION;
	fingerprint: string;
}

export interface GitQuickSummaryNotRepository {
	status: 'not-git-repository';
	project: string;
	fingerprintVersion: typeof GIT_QUICK_SUMMARY_FINGERPRINT_VERSION;
	fingerprint: null;
	message: string;
}

export interface GitQuickSummaryUnknown {
	status: 'unknown';
	project: string;
	fingerprintVersion: typeof GIT_QUICK_SUMMARY_FINGERPRINT_VERSION;
	fingerprint: null;
	message: string;
}

export interface GitWorktreeItem {
	name: string;
	path: string;
	branch: string;
	isCurrent: boolean;
	isMain: boolean;
	isPathMissing: boolean;
	lastModifiedAt: string | null;
}

export interface GitTargetCandidate {
	projectPath: string;
	repoRoot: string;
	worktreePath: string;
	label: string;
	branch: string;
	source: 'chat-project' | 'repo-root' | 'worktree';
	isCurrent: boolean;
	isMissing: boolean;
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

export type GitRefKind = 'local-branch' | 'remote-branch' | 'tag' | 'other';

export interface GitRefOption {
	name: string;
	ref: string;
	kind: GitRefKind;
	isCurrent?: boolean;
}

export interface GitHistoryCommitListResponse {
	project: string;
	ref: string;
	commits: GitHistoryCommitListItem[];
	nextOffset: number | null;
}

export interface GitHistoryCommitListItem {
	hash: string;
	shortHash: string;
	parents: string[];
	author: string;
	authorEmail: string;
	authorDate: string;
	committer: string;
	committerEmail: string;
	committerDate: string;
	subject: string;
	refs: string[];
}

export interface GitCommitDetails {
	hash: string;
	shortHash: string;
	parents: string[];
	author: string;
	authorEmail: string;
	authorDate: string;
	committer: string;
	committerEmail: string;
	committerDate: string;
	subject: string;
	body: string;
	refs: string[];
}

export interface GitCommitParentOption {
	hash: string;
	shortHash: string;
	label: string;
}

export type GitCommitFileStatus =
	'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed' | 'unknown';

export interface GitCommitFileSummary {
	path: string;
	originalPath?: string;
	status: GitCommitFileStatus;
	rawStatus: string;
	category: GitFileReviewCategory;
	additions: number;
	deletions: number;
	statsKnown?: boolean;
	estimatedRows: number;
	bodyState: GitReviewBodyState;
	bodyFingerprint: string;
	isGenerated: boolean;
	isBinary: boolean;
	isTooLarge: boolean;
	limitReason?: GitReviewLimitReason;
	limitMessage?: string;
}

export type GitCommitFileBody = GitReviewFileBody;

export interface GitCommitSnapshotReady {
	status: 'ready';
	project: string;
	documentId: string;
	commit: GitCommitDetails;
	selectedParent: string | null;
	parentOptions: GitCommitParentOption[];
	files: GitCommitFileSummary[];
	limits: GitReviewDocumentLimits;
	collectionLimit?: GitReviewCollectionLimit;
	firstBodyCandidates: string[];
}

export interface GitCommitSnapshotNotFound {
	status: 'not-found';
	project: string;
	commit: string;
	message: string;
}

export type GitCommitSnapshotResponse = GitCommitSnapshotReady | GitCommitSnapshotNotFound;

export interface GitDiffFileRequest {
	path: string;
	originalPath?: string;
}

export interface GitCommitFileBodiesResponse {
	documentId: string;
	files: Record<string, GitCommitFileBody>;
	errors: Record<string, string>;
}

export interface ConfirmAction {
	type: 'discard' | 'delete' | 'commit' | 'pull' | 'push';
	file?: string;
	message?: string;
}

export type GitConflictStatus = 'UU' | 'AA' | 'DD' | 'AU' | 'UA' | 'DU' | 'UD';

export interface GitConflictFile {
	path: string;
	status: GitConflictStatus;
	baseAvailable: boolean;
	oursAvailable: boolean;
	theirsAvailable: boolean;
}

export type GitConflictContentLimitReason = 'content-too-large' | 'too-many-lines';

export interface GitConflictContent {
	content: string | null;
	truncated: boolean;
	byteLength: number;
	lineCount: number;
	limitReason?: GitConflictContentLimitReason;
}

export interface GitConflictDetails {
	path: string;
	base: GitConflictContent;
	ours: GitConflictContent;
	theirs: GitConflictContent;
	working: GitConflictContent;
	truncated: boolean;
}

export interface GitStashEntry {
	index: number;
	ref: string;
	hash: string;
	message: string;
	date: string;
}

export interface GitFileHistoryEntry {
	hash: string;
	author: string;
	email: string;
	date: string;
	subject: string;
}

export interface GitBlameLine {
	line: number;
	originalLine: number;
	finalLine: number;
	commit: string;
	author: string;
	authorMail: string;
	authorTime: string;
	summary: string;
	content: string;
}

export interface GitGraphCommit {
	graph: string;
	hash: string;
	parents: string[];
	decorations: string[];
	author: string;
	date: string;
	subject: string;
}

interface SuccessResponse {
	success: boolean;
	output?: string;
	message?: string;
	error?: string;
	details?: string;
	worktreePath?: string;
}

export interface GenerateCommitMessageResponse {
	message?: string;
	error?: string;
	directoryPrefix?: string;
}

function projectParam(project: string): string {
	return `project=${encodeURIComponent(project)}`;
}

export async function getGitStatus(project: string): Promise<GitStatus> {
	return apiGet<GitStatus>(`/api/v1/git/status?${projectParam(project)}`);
}

export async function getGitDiff(
	project: string,
	file: string,
): Promise<{ diff?: string; error?: string }> {
	return apiGet(`/api/v1/git/diff?${projectParam(project)}&file=${encodeURIComponent(file)}`);
}

export async function getFileWithDiff(
	project: string,
	file: string,
): Promise<{
	currentContent?: string;
	oldContent?: string;
	isDeleted?: boolean;
	isUntracked?: boolean;
	error?: string;
}> {
	return apiGet(
		`/api/v1/git/file-with-diff?${projectParam(project)}&file=${encodeURIComponent(file)}`,
	);
}

export async function gitCommit(
	project: string,
	message: string,
	files: string[],
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/commit', { project, message, files });
}

export async function gitInitialCommit(project: string): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/initial-commit', { project });
}

export async function getBranches(
	project: string,
): Promise<{ branches?: string[]; error?: string }> {
	return apiGet(`/api/v1/git/branches?${projectParam(project)}`);
}

export async function getGitRefs(
	project: string,
	options: { query?: string; limit?: number } = {},
): Promise<{ refs: GitRefOption[]; error?: string }> {
	const params = new URLSearchParams({ project });
	if (options.query) params.set('query', options.query);
	if (options.limit) params.set('limit', String(options.limit));
	return apiGet(`/api/v1/git/refs?${params.toString()}`);
}

export async function gitCheckoutRef(
	project: string,
	ref: string,
	refKind?: GitRefKind,
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/checkout', { project, ref, refKind });
}

export async function gitCheckout(project: string, branch: string): Promise<SuccessResponse> {
	return gitCheckoutRef(project, branch);
}

export async function gitCreateBranch(
	project: string,
	branch: string,
	options: { baseRef?: string } = {},
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/create-branch', {
		project,
		branch,
		baseRef: options.baseRef,
	});
}

export async function getGitHistoryCommits(
	project: string,
	options?: ApiFetchOptions & {
		ref?: string;
		limit?: number;
		offset?: number;
	},
): Promise<GitHistoryCommitListResponse> {
	const { ref = 'HEAD', limit = 50, offset = 0, ...fetchOptions } = options ?? {};
	return apiPost<GitHistoryCommitListResponse>(
		'/api/v1/git/history/commits',
		{ project, ref, limit, offset },
		fetchOptions,
	);
}

export async function getGitCommitSnapshot(
	project: string,
	commit: string,
	options?: ApiFetchOptions & {
		parent?: string | null;
		context?: number;
		bodyCandidateCount?: number;
	},
): Promise<GitCommitSnapshotResponse> {
	const { parent = null, context = 5, bodyCandidateCount = 8, ...fetchOptions } = options ?? {};
	return apiPost<GitCommitSnapshotResponse>(
		'/api/v1/git/history/commit/snapshot',
		{ project, commit, parent, context, bodyCandidateCount },
		fetchOptions,
	);
}

export async function getGitCommitFileBodies(
	project: string,
	documentId: string,
	commit: string,
	files: GitDiffFileRequest[],
	options?: ApiFetchOptions & {
		parent?: string | null;
		context?: number;
	},
): Promise<GitCommitFileBodiesResponse> {
	const { parent = null, context = 5, ...fetchOptions } = options ?? {};
	return apiPost<GitCommitFileBodiesResponse>(
		'/api/v1/git/history/commit/files',
		{ project, documentId, commit, parent, context, files },
		fetchOptions,
	);
}

export async function generateCommitMessage(
	project: string,
	files: string[],
): Promise<GenerateCommitMessageResponse> {
	return apiPost('/api/v1/git/generate-commit-message', { project, files }, { timeoutMs: 120_000 });
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

// Workbench API

export async function getGitWorkbenchSnapshot(
	project: string,
	tab: GitDiffTab,
	context = 5,
	options?: ApiFetchOptions & {
		selectedFile?: string | null;
		bodyCandidateCount?: number;
	},
): Promise<GitWorkbenchSnapshotResponse> {
	const mode = tab === 'staged' ? 'staged' : 'working';
	const { selectedFile = null, bodyCandidateCount = 8, ...fetchOptions } = options ?? {};
	return apiPost<GitWorkbenchSnapshotResponse>(
		'/api/v1/git/workbench/snapshot',
		{
			project,
			mode,
			context,
			selectedFile,
			bodyCandidateCount,
		},
		fetchOptions,
	);
}

export async function getGitWorkingTreeFingerprint(
	project: string,
	options?: ApiFetchOptions,
): Promise<GitWorkingTreeFingerprintResponse> {
	return apiPost<GitWorkingTreeFingerprintResponse>(
		'/api/v1/git/working-tree/fingerprint',
		{ project },
		options,
	);
}

export async function getGitQuickSummary(
	project: string,
	options?: ApiFetchOptions,
): Promise<GitQuickSummaryResponse> {
	return apiPost<GitQuickSummaryResponse>('/api/v1/git/quick-summary', { project }, options);
}

export async function getGitReviewFileBodies(
	project: string,
	documentId: string,
	files: string[],
	tab: GitDiffTab,
	context = 5,
	options?: ApiFetchOptions,
): Promise<GitReviewFileBodiesResponse> {
	const mode = tab === 'staged' ? 'staged' : 'working';
	return apiPost<GitReviewFileBodiesResponse>(
		'/api/v1/git/review-document/files',
		{ project, documentId, files, mode, context },
		options,
	);
}

export async function getGitConflicts(
	project: string,
	options?: ApiFetchOptions,
): Promise<{ conflicts: GitConflictFile[] }> {
	return apiGet<{ conflicts: GitConflictFile[] }>(
		`/api/v1/git/conflicts?${projectParam(project)}`,
		options,
	);
}

export async function getGitConflictDetails(
	project: string,
	file: string,
	options?: ApiFetchOptions,
): Promise<GitConflictDetails> {
	return apiGet<GitConflictDetails>(
		`/api/v1/git/conflict-details?${projectParam(project)}&file=${encodeURIComponent(file)}`,
		options,
	);
}

export async function gitAcceptConflictSide(
	project: string,
	file: string,
	side: 'ours' | 'theirs',
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/conflict/accept', { project, file, side });
}

export async function gitMarkConflictResolved(
	project: string,
	file: string,
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/conflict/resolve', { project, file });
}

export async function getGitStashes(
	project: string,
	options?: ApiFetchOptions,
): Promise<{ stashes: GitStashEntry[] }> {
	return apiGet<{ stashes: GitStashEntry[] }>(
		`/api/v1/git/stashes?${projectParam(project)}`,
		options,
	);
}

export async function gitCreateStash(
	project: string,
	message = '',
	includeUntracked = false,
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/stash/create', {
		project,
		message,
		includeUntracked,
	});
}

export async function gitApplyStash(project: string, stashRef: string): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/stash/apply', { project, stashRef });
}

export async function gitPopStash(project: string, stashRef: string): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/stash/pop', { project, stashRef });
}

export async function gitDropStash(project: string, stashRef: string): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/stash/drop', { project, stashRef });
}

export async function getGitFileHistory(
	project: string,
	file: string,
	limit = 50,
	options?: ApiFetchOptions,
): Promise<{ commits: GitFileHistoryEntry[] }> {
	return apiGet<{ commits: GitFileHistoryEntry[] }>(
		`/api/v1/git/file-history?${projectParam(project)}&file=${encodeURIComponent(file)}&limit=${limit}`,
		options,
	);
}

export async function getGitBlame(
	project: string,
	file: string,
	ref = 'HEAD',
	limit = 2000,
	options?: ApiFetchOptions,
): Promise<{ lines: GitBlameLine[]; truncated: boolean }> {
	return apiGet<{ lines: GitBlameLine[]; truncated: boolean }>(
		`/api/v1/git/blame?${projectParam(project)}&file=${encodeURIComponent(file)}&ref=${encodeURIComponent(ref)}&limit=${limit}`,
		options,
	);
}

export async function getGitGraph(
	project: string,
	limit = 200,
	options?: ApiFetchOptions,
): Promise<{ commits: GitGraphCommit[] }> {
	return apiGet<{ commits: GitGraphCommit[] }>(
		`/api/v1/git/graph?${projectParam(project)}&limit=${limit}`,
		options,
	);
}

export async function getGitTargetCandidates(
	project: string,
	options?: ApiFetchOptions,
): Promise<{ targets: GitTargetCandidate[] }> {
	return apiGet<{ targets: GitTargetCandidate[] }>(
		`/api/v1/git/targets?${projectParam(project)}`,
		options,
	);
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
	options?: ApiFetchOptions,
): Promise<{ worktrees: GitWorktreeItem[] }> {
	return apiGet<{ worktrees: GitWorktreeItem[] }>(
		`/api/v1/git/worktrees?${projectParam(project)}`,
		options,
	);
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

export async function gitRevertCommit(project: string, commit: string): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/revert-commit', {
		project,
		commit,
	});
}

export async function gitCommitIndex(project: string, message: string): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/commit-index', {
		project,
		message,
	});
}

export async function gitStagePaths(
	project: string,
	paths: string[],
	mode: GitStageMode,
): Promise<SuccessResponse> {
	return apiPost<SuccessResponse>('/api/v1/git/stage-paths', {
		project,
		paths,
		mode,
	});
}
