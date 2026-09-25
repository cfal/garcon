import type * as Wire from '$shared/git';
import { apiPost, type ApiFetchOptions } from './client.js';
import {
	gitApiGet,
	gitApiPost,
	gitApiMutation,
	gitProjectFields,
	gitProjectQuery,
	gitDocumentRef,
	gitDocumentKey,
	type GitProjectTarget,
	type GitReviewDocumentRef,
	type GitSelectionProof,
} from './git-client.js';
import {
	DEFAULT_GIT_REF_SORT,
	type GitRefKind,
	type GitRefsResponse,
	type GitRefSort,
} from '$shared/git-refs';
export {
	DEFAULT_GIT_REF_SORT,
	GIT_REF_RESULT_LIMITS,
	type GitRefKind,
	type GitRefOption,
	type GitRefsResponse,
	type GitRefSort,
	type GitRefSortDirection,
	type GitRefSortKey,
} from '$shared/git-refs';
import {
	getGitReviewDocumentFileBodies,
	type GitReviewBodyPurpose,
	type GitReviewDocumentIndexedFileBodiesResponse,
	type GitReviewFileBody,
	type GitReviewDocumentSummary,
} from './git-review-documents.js';
export {
	getGitReviewDocumentFileBodies,
	type GitFileReviewMode,
	type GitReviewBodyPurpose,
	type GitReviewBodyState,
	type GitReviewCollectionLimit,
	type GitReviewDocumentFileBodiesExpired,
	type GitReviewDocumentFileBodiesReady,
	type GitReviewDocumentFileBodiesResponse,
	type GitReviewDocumentFileBodiesStale,
	type GitReviewDocumentIndexedFileBodiesReady,
	type GitReviewDocumentIndexedFileBodiesResponse,
	type GitReviewDocumentLimits,
	type GitReviewFileBody,
	type GitReviewFilePatchBody,
	type GitReviewFileSummary,
	type GitReviewLimitReason,
	type GitReviewDocumentSummary,
	DEFAULT_GIT_REVIEW_DOCUMENT_LIMITS,
} from './git-review-documents.js';
import {
	finishGitReviewPerformanceSpan,
	registerGitReviewDocument,
	startGitReviewPerformanceSpan,
} from '$lib/git/review/git-review-performance.js';

// Workbench contract types

export type GitChangeKind = Wire.GitChangeKind;
export type GitStatusCode = ' ' | 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?' | '!';
export type GitFileReviewCategory = Wire.GitFileReviewCategory;
export type GitStageMode = Wire.GitStageMode;
export const GIT_FRESHNESS_POLL_MS = 15_000;
export {
	GIT_WORKING_TREE_FINGERPRINT_VERSION,
	GIT_QUICK_SUMMARY_FINGERPRINT_VERSION,
} from '$shared/git';
export type GitChangeStats = Wire.DiffStats;

export type GitTreeStatsState = Wire.GitTreeStatsState;

export type GitFileChangeFacet = Wire.ChangeFacet;

export interface GitTreeNode extends Omit<
	Wire.TreeNode,
	'indexStatus' | 'workTreeStatus' | 'children'
> {
	indexStatus?: string;
	workTreeStatus?: string;
	children?: GitTreeNode[];
}

export interface GitChangesTreeResult extends Omit<Wire.ChangesTreeResult, 'root' | 'statsState'> {
	root: GitTreeNode[];
	statsState?: GitTreeStatsState;
}

export type GitDiffTab = 'unstaged' | 'staged';

export interface GitWorkbenchSnapshotTarget extends Wire.GitWorkbenchSnapshotTarget {
	executorId: string;
}

export interface GitWorkbenchSnapshotReady extends Omit<
	Wire.GitWorkbenchSnapshotReady,
	'target' | 'tree' | 'reviewSummary'
> {
	target: GitWorkbenchSnapshotTarget;
	tree: GitChangesTreeResult & { statsState: 'loaded' };
	reviewSummary: GitReviewDocumentSummary;
}

export type GitWorkbenchSnapshotNotRepository = Wire.GitWorkbenchSnapshotNotRepository;

export type GitWorkbenchSnapshotResponse =
	GitWorkbenchSnapshotReady | GitWorkbenchSnapshotNotRepository;

export type GitWorkingTreeFingerprintResponse = Wire.GitWorkingTreeFingerprintResponse;

export type GitWorkingTreeFingerprintReady = Wire.GitWorkingTreeFingerprintReady;

export type GitWorkingTreeFingerprintNotRepository = Wire.GitWorkingTreeFingerprintNotRepository;

export type GitWorkingTreeFingerprintUnknown = Wire.GitWorkingTreeFingerprintUnknown;

export type GitQuickSummaryResponse = Wire.GitQuickSummaryResponse;

export type GitQuickSummaryReady = Wire.GitQuickSummaryReady;

export type GitQuickSummaryNotRepository = Wire.GitQuickSummaryNotRepository;

export type GitQuickSummaryUnknown = Wire.GitQuickSummaryUnknown;

export type GitWorktreeItem = Wire.WorktreeInfo;

export type GitTargetCandidate = Wire.TargetCandidate;

export interface GitStatus extends Wire.GitStatus {
	error?: string;
	details?: string;
}

export interface GitRemoteStatus extends Wire.GitRemoteStatus {
	error?: string;
}

export type GitHistoryCommitListResponse = Wire.GitHistoryCommitListResponse;

export type GitHistoryCommitListItem = Wire.GitHistoryCommitListItem;

export type GitCommitDetails = Wire.GitCommitDetails;

export type GitCommitParentOption = Wire.GitCommitParentOption;

export type GitCommitFileStatus = Wire.GitCommitFileStatus;

export type GitCommitFileSummary = Wire.GitCommitFileSummary;

export type GitCommitFileBody = GitReviewFileBody;

export interface GitCommitSnapshotReady extends Wire.GitCommitSnapshotReady {
	document: GitReviewDocumentRef;
}

export type GitCommitSnapshotNotFound = Wire.GitCommitSnapshotNotFound;

export type GitCommitSnapshotResponse = GitCommitSnapshotReady | GitCommitSnapshotNotFound;

export type GitDiffFileRequest = Wire.GitDiffFileRequest;

export interface ConfirmAction {
	type: 'discard' | 'delete' | 'commit' | 'pull' | 'push';
	file?: string;
	message?: string;
}

export type GitConflictStatus = Wire.GitConflictStatus;

export type GitConflictFile = Wire.GitConflictFile;

export type GitConflictContentLimitReason = Wire.GitConflictContentLimitReason;

export type GitConflictContent = Wire.GitConflictContent;

export type GitConflictDetails = Wire.GitConflictDetails;

export type GitStashEntry = Wire.GitStashEntry;

export type GitFileHistoryEntry = Wire.GitFileHistoryEntry;

export type GitBlameLine = Wire.GitBlameLine;

export type GitGraphCommit = Wire.GitGraphCommit;

interface SuccessResponse {
	outputTruncated?: boolean;
	success: boolean;
	output?: string;
	message?: string;
	error?: string;
	details?: string;
	worktreePath?: string;
}

export interface GitCommitResponse extends SuccessResponse {
	commitScope: 'selected-files' | 'whole-index';
	indexSynchronized: boolean;
}

export interface GenerateCommitMessageResponse {
	message?: string;
	error?: string;
	directoryPrefix?: string;
}

function projectParam(target: GitProjectTarget): string {
	return gitProjectQuery(target);
}

export async function getGitStatus(target: GitProjectTarget): Promise<GitStatus> {
	return gitApiGet<GitStatus>(target, `/api/v1/git/status?${projectParam(target)}`);
}

export async function gitCommit(
	target: GitProjectTarget,
	message: string,
	files: string[],
): Promise<GitCommitResponse> {
	return gitApiMutation<GitCommitResponse>(target, '/api/v1/git/commit', {
		...gitProjectFields(target),
		message,
		files,
	});
}

export async function gitInitialCommit(target: GitProjectTarget): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/initial-commit', {
		...gitProjectFields(target),
	});
}

export async function getBranches(
	target: GitProjectTarget,
): Promise<{ branches?: string[]; error?: string }> {
	return gitApiGet(target, `/api/v1/git/branches?${projectParam(target)}`);
}

export type GetGitRefsOptions = ApiFetchOptions & {
	query?: string;
	limit?: number;
	sort?: GitRefSort;
};

export async function getGitRefs(
	target: GitProjectTarget,
	options: GetGitRefsOptions = {},
): Promise<GitRefsResponse & { error?: string }> {
	const { query, limit, sort = DEFAULT_GIT_REF_SORT, ...fetchOptions } = options;
	const params = new URLSearchParams({
		...gitProjectFields(target),
		sort: sort.key,
		direction: sort.direction,
	});
	if (query) params.set('query', query);
	if (limit) params.set('limit', String(limit));
	return gitApiGet(target, `/api/v1/git/refs?${params.toString()}`, fetchOptions);
}

export async function gitCheckoutRef(
	target: GitProjectTarget,
	ref: string,
	refKind?: GitRefKind,
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/checkout', {
		...gitProjectFields(target),
		ref,
		refKind,
	});
}

export async function gitCheckout(
	target: GitProjectTarget,
	branch: string,
): Promise<SuccessResponse> {
	return gitCheckoutRef(target, branch);
}

export async function gitCreateBranch(
	target: GitProjectTarget,
	branch: string,
	options: { baseRef?: string } = {},
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/create-branch', {
		...gitProjectFields(target),
		branch,
		baseRef: options.baseRef,
	});
}

export async function getGitHistoryCommits(
	target: GitProjectTarget,
	options?: ApiFetchOptions & {
		ref?: string;
		limit?: number;
		offset?: number;
	},
): Promise<GitHistoryCommitListResponse> {
	const { ref = 'HEAD', limit = 50, offset = 0, ...fetchOptions } = options ?? {};
	return gitApiPost<GitHistoryCommitListResponse>(
		target,
		'/api/v1/git/history/commits',
		{ ...gitProjectFields(target), ref, limit, offset },
		fetchOptions,
	);
}

export async function getGitCommitSnapshot(
	target: GitProjectTarget,
	commit: string,
	options?: ApiFetchOptions & {
		parent?: string | null;
		context?: number;
		bodyCandidateCount?: number;
	},
): Promise<GitCommitSnapshotResponse> {
	const { parent = null, context = 5, bodyCandidateCount = 8, ...fetchOptions } = options ?? {};
	const span = startGitReviewPerformanceSpan('snapshot');
	try {
		const response = await gitApiPost<Wire.GitCommitSnapshotResponse>(
			target,
			'/api/v1/git/history/commit/snapshot',
			{ ...gitProjectFields(target), commit, parent, context, bodyCandidateCount },
			fetchOptions,
		);
		if (response.status !== 'ready') return response;
		const document = gitDocumentRef(response, response.documentId);
		registerGitReviewDocument(gitDocumentKey(document), span);
		return { ...response, document, documentId: gitDocumentKey(document) };
	} finally {
		finishGitReviewPerformanceSpan(span);
	}
}

export async function getGitCommitFileBodies(
	target: GitProjectTarget,
	document: GitReviewDocumentRef,
	commit: string,
	files: GitDiffFileRequest[],
	options?: ApiFetchOptions & {
		parent?: string | null;
		context?: number;
		purpose?: GitReviewBodyPurpose;
	},
): Promise<GitReviewDocumentIndexedFileBodiesResponse> {
	const {
		parent: _parent = null,
		context: _context = 5,
		purpose = 'prefetch',
		...fetchOptions
	} = options ?? {};
	return getGitReviewDocumentFileBodies(
		target,
		document,
		files.map((file) => file.path),
		purpose,
		fetchOptions,
	);
}

export async function generateCommitMessage(
	target: GitProjectTarget,
	files: string[],
): Promise<GenerateCommitMessageResponse> {
	return apiPost(
		'/api/v1/git/generate-commit-message',
		{ ...gitProjectFields(target), files },
		{ timeoutMs: 120_000 },
	);
}

export async function getRemoteStatus(target: GitProjectTarget): Promise<GitRemoteStatus> {
	return gitApiGet<GitRemoteStatus>(target, `/api/v1/git/remote-status?${projectParam(target)}`);
}

export async function gitFetch(target: GitProjectTarget): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/fetch', {
		...gitProjectFields(target),
	});
}

export async function gitPull(target: GitProjectTarget): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/pull', {
		...gitProjectFields(target),
	});
}

export async function gitPush(
	target: GitProjectTarget,
	remote?: string,
	remoteBranch?: string,
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/push', {
		...gitProjectFields(target),
		remote,
		remoteBranch,
	});
}

export type GitRemoteEntry = Wire.RemoteInfo;

export async function getGitRemotes(
	target: GitProjectTarget,
): Promise<{ remotes: GitRemoteEntry[]; error?: string }> {
	return gitApiGet<{ remotes: GitRemoteEntry[]; error?: string }>(
		target,
		`/api/v1/git/remotes?${projectParam(target)}`,
	);
}

export async function gitDiscard(target: GitProjectTarget, file: string): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/discard', {
		...gitProjectFields(target),
		file,
	});
}

export async function gitDeleteUntracked(
	target: GitProjectTarget,
	file: string,
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/delete-untracked', {
		...gitProjectFields(target),
		file,
	});
}

// Workbench API

export async function getGitWorkbenchSnapshot(
	target: GitProjectTarget,
	tab: GitDiffTab,
	context = 5,
	options?: ApiFetchOptions & {
		selectedFile?: string | null;
		bodyCandidateCount?: number;
	},
): Promise<GitWorkbenchSnapshotResponse> {
	const mode = tab === 'staged' ? 'staged' : 'working';
	const { selectedFile = null, bodyCandidateCount = 8, ...fetchOptions } = options ?? {};
	const span = startGitReviewPerformanceSpan('snapshot');
	try {
		const response = await gitApiPost<Wire.GitWorkbenchSnapshotResponse>(
			target,
			'/api/v1/git/workbench/snapshot',
			{
				...gitProjectFields(target),
				mode,
				context,
				selectedFile,
				bodyCandidateCount,
			},
			fetchOptions,
		);
		if (response.status === 'ready') {
			const document = gitDocumentRef(response, response.reviewSummary.documentId);
			registerGitReviewDocument(gitDocumentKey(document), span);
			return {
				...response,
				target: { ...response.target, executorId: target.executorId },
				reviewSummary: {
					...response.reviewSummary,
					document,
					documentId: gitDocumentKey(document),
				},
			};
		}
		return response;
	} finally {
		finishGitReviewPerformanceSpan(span);
	}
}

export async function getGitWorkingTreeFingerprint(
	target: GitProjectTarget,
	options?: ApiFetchOptions,
): Promise<GitWorkingTreeFingerprintResponse> {
	return gitApiPost<GitWorkingTreeFingerprintResponse>(
		target,
		'/api/v1/git/working-tree/fingerprint',
		{ ...gitProjectFields(target) },
		options,
	);
}

export async function getGitQuickSummary(
	target: GitProjectTarget,
	options?: ApiFetchOptions,
): Promise<GitQuickSummaryResponse> {
	return gitApiPost<GitQuickSummaryResponse>(
		target,
		'/api/v1/git/quick-summary',
		{ ...gitProjectFields(target) },
		options,
	);
}

export async function getGitReviewFileBodies(
	target: GitProjectTarget,
	document: GitReviewDocumentRef,
	files: string[],
	tab: GitDiffTab,
	context = 5,
	options?: ApiFetchOptions & { purpose?: GitReviewBodyPurpose },
): Promise<GitReviewDocumentIndexedFileBodiesResponse> {
	void tab;
	void context;
	const { purpose = 'prefetch', ...fetchOptions } = options ?? {};
	return getGitReviewDocumentFileBodies(target, document, files, purpose, fetchOptions);
}

export async function getGitConflicts(
	target: GitProjectTarget,
	options?: ApiFetchOptions,
): Promise<{ conflicts: GitConflictFile[] }> {
	return gitApiGet<{ conflicts: GitConflictFile[] }>(
		target,
		`/api/v1/git/conflicts?${projectParam(target)}`,
		options,
	);
}

export async function getGitConflictDetails(
	target: GitProjectTarget,
	file: string,
	options?: ApiFetchOptions,
): Promise<GitConflictDetails> {
	return gitApiGet<GitConflictDetails>(
		target,
		`/api/v1/git/conflict-details?${projectParam(target)}&file=${encodeURIComponent(file)}`,
		options,
	);
}

export async function gitAcceptConflictSide(
	target: GitProjectTarget,
	file: string,
	side: 'ours' | 'theirs',
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/conflict/accept', {
		...gitProjectFields(target),
		file,
		side,
	});
}

export async function gitMarkConflictResolved(
	target: GitProjectTarget,
	file: string,
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/conflict/resolve', {
		...gitProjectFields(target),
		file,
	});
}

export async function getGitStashes(
	target: GitProjectTarget,
	options?: ApiFetchOptions,
): Promise<{ stashes: GitStashEntry[] }> {
	return gitApiGet<{ stashes: GitStashEntry[] }>(
		target,
		`/api/v1/git/stashes?${projectParam(target)}`,
		options,
	);
}

export async function gitCreateStash(
	target: GitProjectTarget,
	message = '',
	includeUntracked = false,
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/stash/create', {
		...gitProjectFields(target),
		message,
		includeUntracked,
	});
}

export async function gitApplyStash(
	target: GitProjectTarget,
	stashRef: string,
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/stash/apply', {
		...gitProjectFields(target),
		stashRef,
	});
}

export async function gitPopStash(
	target: GitProjectTarget,
	stashRef: string,
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/stash/pop', {
		...gitProjectFields(target),
		stashRef,
	});
}

export async function gitDropStash(
	target: GitProjectTarget,
	stashRef: string,
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/stash/drop', {
		...gitProjectFields(target),
		stashRef,
	});
}

export async function getGitFileHistory(
	target: GitProjectTarget,
	file: string,
	limit = 50,
	options?: ApiFetchOptions,
): Promise<{ commits: GitFileHistoryEntry[] }> {
	return gitApiGet<{ commits: GitFileHistoryEntry[] }>(
		target,
		`/api/v1/git/file-history?${projectParam(target)}&file=${encodeURIComponent(file)}&limit=${limit}`,
		options,
	);
}

export async function getGitBlame(
	target: GitProjectTarget,
	file: string,
	ref = 'HEAD',
	limit = 2000,
	options?: ApiFetchOptions,
): Promise<{ lines: GitBlameLine[]; truncated: boolean }> {
	return gitApiGet<{ lines: GitBlameLine[]; truncated: boolean }>(
		target,
		`/api/v1/git/blame?${projectParam(target)}&file=${encodeURIComponent(file)}&ref=${encodeURIComponent(ref)}&limit=${limit}`,
		options,
	);
}

export async function getGitGraph(
	target: GitProjectTarget,
	limit = 200,
	options?: ApiFetchOptions,
): Promise<{ commits: GitGraphCommit[] }> {
	return gitApiGet<{ commits: GitGraphCommit[] }>(
		target,
		`/api/v1/git/graph?${projectParam(target)}&limit=${limit}`,
		options,
	);
}

export async function getGitTargetCandidates(
	target: GitProjectTarget,
	options?: ApiFetchOptions,
): Promise<{ targets: GitTargetCandidate[] }> {
	return gitApiGet<{ targets: GitTargetCandidate[] }>(
		target,
		`/api/v1/git/targets?${projectParam(target)}`,
		options,
	);
}

export async function gitStageSelection(
	target: GitProjectTarget,
	file: string,
	mode: 'stage' | 'unstage',
	lineIndices: number[],
	contextLines: number,
	proof: GitSelectionProof,
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/stage-selection', {
		...gitProjectFields(target),
		file,
		mode,
		selection: { lineIndices },
		contextLines,
		...proof,
	});
}

export async function gitStageHunk(
	target: GitProjectTarget,
	file: string,
	mode: 'stage' | 'unstage',
	hunkIndex: number,
	contextLines: number,
	proof: GitSelectionProof,
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/stage-hunk', {
		...gitProjectFields(target),
		file,
		mode,
		hunkIndex,
		contextLines,
		...proof,
	});
}

export async function getGitWorktrees(
	target: GitProjectTarget,
	options?: ApiFetchOptions,
): Promise<{ worktrees: GitWorktreeItem[] }> {
	return gitApiGet<{ worktrees: GitWorktreeItem[] }>(
		target,
		`/api/v1/git/worktrees?${projectParam(target)}`,
		options,
	);
}

export async function gitCreateWorktree(
	target: GitProjectTarget,
	worktreePath: string,
	options: { baseRef?: string; branch?: string; detach?: boolean } = {},
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/worktrees/create', {
		...gitProjectFields(target),
		worktreePath,
		...options,
	});
}

export async function gitRemoveWorktree(
	target: GitProjectTarget,
	worktreePath: string,
	force = false,
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/worktrees/remove', {
		...gitProjectFields(target),
		worktreePath,
		force,
	});
}

export async function gitRevertCommit(
	target: GitProjectTarget,
	commit: string,
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/revert-commit', {
		...gitProjectFields(target),
		commit,
	});
}

export async function gitCommitIndex(
	target: GitProjectTarget,
	message: string,
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/commit-index', {
		...gitProjectFields(target),
		message,
	});
}

export async function gitStagePaths(
	target: GitProjectTarget,
	paths: string[],
	mode: GitStageMode,
): Promise<SuccessResponse> {
	return gitApiMutation<SuccessResponse>(target, '/api/v1/git/stage-paths', {
		...gitProjectFields(target),
		paths,
		mode,
	});
}
