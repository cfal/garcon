import {
	getGitCommitFileBodies,
	getGitCommitSnapshot,
	getGitHistoryCommits,
	type GitCommitFileBody,
	type GitCommitFileSummary,
	type GitCommitSnapshotReady,
	type GitHistoryCommitListItem,
	type GitReviewDocumentSummary,
	type GitReviewFileSummary,
	type GitStatusCode,
} from '$lib/api/git.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import type { CommentComposerState } from '$lib/git/review/git-review-drafts.svelte.js';
import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';
import {
	buildVirtualRows,
	type GitVirtualReviewRow,
} from '$lib/git/review/git-virtual-review-document.svelte.js';
import * as m from '$lib/paraglide/messages.js';

export type GitHistoryScreen = 'list' | 'commit';

export interface GitHistoryRevertTarget {
	hash: string;
	shortHash: string;
	subject: string;
}

interface HistoryLoadGuard {
	generation: number;
	projectPath: string;
	commitHash: string | null;
	parentHash: string | null;
	contextLines: number;
}

type BodyCacheKey = `${string}|${string}|${string}|${number}|${string}|${string}`;

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_CONTEXT_LINES = 5;
const DEFAULT_DIFF_MODE: DiffMode = 'unified';
const BODY_CANDIDATE_COUNT = 8;
const CLOSED_COMPOSER: CommentComposerState = {
	open: false,
	filePath: '',
	side: 'after',
	line: 0,
	body: '',
	severity: 'note',
};

export class GitHistoryController {
	screen = $state<GitHistoryScreen>('list');
	commits = $state<GitHistoryCommitListItem[]>([]);
	nextOffset = $state<number | null>(0);
	listLoading = $state(false);
	listError = $state<string | null>(null);
	selectedCommitHash = $state<string | null>(null);
	selectedParentHash = $state<string | null>(null);
	commitSnapshot = $state<GitCommitSnapshotReady | null>(null);
	commitLoading = $state(false);
	commitError = $state<string | null>(null);
	fileBodies = $state<Record<string, GitCommitFileBody>>({});
	loadingBodies = $state(new Set<string>());
	scrollRequest = $state<{ filePath: string; token: number } | null>(null);
	listScrollTop = $state(0);
	fileFilter = $state('');
	focusedFilePath = $state<string | null>(null);
	diffMode = $state<DiffMode>(DEFAULT_DIFF_MODE);
	contextLines = $state(DEFAULT_CONTEXT_LINES);

	private listAbort: AbortController | null = null;
	private commitAbort: AbortController | null = null;
	private bodyAbort: AbortController | null = null;
	private bodyBatchFiles = new Set<string>();
	private pendingBodyQueue: string[] = [];
	private bodyCache = new Map<BodyCacheKey, GitCommitFileBody>();
	private listGeneration = 0;
	private commitGeneration = 0;
	private scrollToken = 0;
	private loadedProjectPath: string | null = null;

	visibleFiles = $derived.by<GitCommitFileSummary[]>(() => {
		const snapshot = this.commitSnapshot;
		if (!snapshot) return [];
		const filter = this.fileFilter.trim().toLowerCase();
		if (!filter) return snapshot.files;
		return snapshot.files.filter((file) =>
			[file.path, file.originalPath ?? '', file.status, file.rawStatus, file.category].some(
				(value) => value.toLowerCase().includes(filter),
			),
		);
	});

	private reviewSummary = $derived.by<GitReviewDocumentSummary | null>(() => {
		const snapshot = this.commitSnapshot;
		if (!snapshot) return null;
		const filterActive = this.fileFilter.trim().length > 0;
		return {
			documentId: snapshot.documentId,
			project: snapshot.project,
			mode: 'staged',
			context: this.contextLines,
			files: this.visibleFiles.map(commitFileToReviewFile),
			limits: snapshot.limits,
			...(filterActive
				? {}
				: snapshot.collectionLimit
					? { collectionLimit: snapshot.collectionLimit }
					: {}),
		};
	});

	virtualRows = $derived.by<GitVirtualReviewRow[]>(() => {
		const summary = this.reviewSummary;
		if (!summary) return [];
		return buildVirtualRows({
			summary,
			visibleFilePaths: summary.files.map((file) => file.path),
			fileBodies: this.fileBodies,
			loadingBodies: this.loadingBodies,
			focusedFilePath: this.focusedFilePath,
			diffMode: this.diffMode,
			activeTab: 'staged',
			contextLines: this.contextLines,
			commentsByFile: {},
			composerState: CLOSED_COMPOSER,
			selectedLineKeys: new Set(),
			readOnly: true,
		});
	});

	fileRowIndex = $derived.by(() => {
		const index = new Map<string, number>();
		this.virtualRows.forEach((row, rowIndex) => {
			if (row.kind === 'file-header') index.set(row.filePath, rowIndex);
		});
		return index;
	});

	setDisplayOptions(projectPath: string | null, diffMode: DiffMode, contextLines: number): void {
		const normalizedContext = Number.isFinite(contextLines)
			? Math.max(0, Math.round(contextLines))
			: DEFAULT_CONTEXT_LINES;
		const contextChanged = this.contextLines !== normalizedContext;
		this.diffMode = diffMode;
		this.contextLines = normalizedContext;
		if (contextChanged && projectPath && this.screen === 'commit' && this.selectedCommitHash) {
			this.loadCommitSnapshot(projectPath, this.selectedCommitHash, this.selectedParentHash);
		}
	}

	loadInitial(projectPath: string): void {
		if (this.loadedProjectPath !== projectPath) this.resetForProject(projectPath);
		this.listAbort?.abort();
		const controller = new AbortController();
		const generation = ++this.listGeneration;
		this.listAbort = controller;
		this.listLoading = true;
		this.listError = null;
		this.nextOffset = 0;

		void getGitHistoryCommits(projectPath, {
			limit: DEFAULT_HISTORY_LIMIT,
			offset: 0,
			signal: controller.signal,
		})
			.then((result) => {
				if (!this.isCurrentListRequest(generation, projectPath, controller.signal)) return;
				this.commits = result.commits;
				this.nextOffset = result.nextOffset;
			})
			.catch((error) => {
				if (
					isAbortError(error) ||
					!this.isCurrentListRequest(generation, projectPath, controller.signal)
				) {
					return;
				}
				this.listError = m.git_history_load_commits_failed({
					detail: error instanceof Error ? error.message : String(error),
				});
				this.commits = [];
				this.nextOffset = null;
			})
			.finally(() => {
				if (this.isCurrentListRequest(generation, projectPath, controller.signal)) {
					this.listLoading = false;
				}
			});
	}

	loadMore(projectPath: string): void {
		if (this.listLoading || this.nextOffset === null) return;
		this.listAbort?.abort();
		const controller = new AbortController();
		const generation = ++this.listGeneration;
		const offset = this.nextOffset;
		this.listAbort = controller;
		this.listLoading = true;
		this.listError = null;

		void getGitHistoryCommits(projectPath, {
			limit: DEFAULT_HISTORY_LIMIT,
			offset,
			signal: controller.signal,
		})
			.then((result) => {
				if (!this.isCurrentListRequest(generation, projectPath, controller.signal)) return;
				const existing = new Set(this.commits.map((commit) => commit.hash));
				this.commits = [
					...this.commits,
					...result.commits.filter((commit) => !existing.has(commit.hash)),
				];
				this.nextOffset = result.nextOffset;
			})
			.catch((error) => {
				if (
					isAbortError(error) ||
					!this.isCurrentListRequest(generation, projectPath, controller.signal)
				) {
					return;
				}
				this.listError = m.git_history_load_more_commits_failed({
					detail: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				if (this.isCurrentListRequest(generation, projectPath, controller.signal)) {
					this.listLoading = false;
				}
			});
	}

	openCommit(projectPath: string, commitHash: string): void {
		this.screen = 'commit';
		this.selectedCommitHash = commitHash;
		this.selectedParentHash = null;
		this.focusedFilePath = null;
		this.fileFilter = '';
		this.loadCommitSnapshot(projectPath, commitHash, null);
	}

	backToList(): void {
		this.screen = 'list';
		this.commitAbort?.abort();
		this.bodyAbort?.abort();
		this.bodyAbort = null;
		this.bodyBatchFiles = new Set();
		this.pendingBodyQueue = [];
		this.loadingBodies = new Set();
		this.scrollRequest = null;
		this.commitLoading = false;
	}

	selectParent(projectPath: string, parentHash: string | null): void {
		if (!this.selectedCommitHash || parentHash === this.selectedParentHash) return;
		this.selectedParentHash = parentHash;
		this.loadCommitSnapshot(projectPath, this.selectedCommitHash, parentHash);
	}

	focusFile(projectPath: string, filePath: string): void {
		this.focusedFilePath = filePath;
		this.requestBodies(projectPath, [filePath]);
		this.scrollToken += 1;
		this.scrollRequest = { filePath, token: this.scrollToken };
	}

	setVisibleRows(projectPath: string, rows: GitVirtualReviewRow[]): void {
		const filePaths = Array.from(new Set(rows.map((row) => row.filePath).filter(Boolean)));
		this.requestBodies(projectPath, filePaths);
	}

	setFileFilter(value: string): void {
		this.fileFilter = value;
	}

	saveListScrollTop(value: number): void {
		this.listScrollTop = value;
	}

	retryCommit(projectPath: string): void {
		if (!this.selectedCommitHash) return;
		this.loadCommitSnapshot(projectPath, this.selectedCommitHash, this.selectedParentHash);
	}

	resetForProject(projectPath: string | null = null): void {
		this.listAbort?.abort();
		this.commitAbort?.abort();
		this.bodyAbort?.abort();
		this.listAbort = null;
		this.commitAbort = null;
		this.bodyAbort = null;
		this.bodyBatchFiles = new Set();
		this.pendingBodyQueue = [];
		this.bodyCache.clear();
		this.listGeneration += 1;
		this.commitGeneration += 1;
		this.loadedProjectPath = projectPath;
		this.screen = 'list';
		this.commits = [];
		this.nextOffset = 0;
		this.listLoading = false;
		this.listError = null;
		this.selectedCommitHash = null;
		this.selectedParentHash = null;
		this.commitSnapshot = null;
		this.commitLoading = false;
		this.commitError = null;
		this.fileBodies = {};
		this.loadingBodies = new Set();
		this.scrollRequest = null;
		this.listScrollTop = 0;
		this.fileFilter = '';
		this.focusedFilePath = null;
	}

	private loadCommitSnapshot(
		projectPath: string,
		commitHash: string,
		parentHash: string | null,
	): void {
		this.commitAbort?.abort();
		this.bodyAbort?.abort();
		this.bodyAbort = null;
		this.bodyBatchFiles = new Set();
		this.pendingBodyQueue = [];
		this.loadingBodies = new Set();
		this.fileBodies = {};
		this.commitSnapshot = null;
		this.commitError = null;
		this.commitLoading = true;
		this.focusedFilePath = null;
		this.scrollRequest = null;
		const controller = new AbortController();
		const generation = ++this.commitGeneration;
		const guard = this.createGuard(projectPath, generation);
		this.commitAbort = controller;

		void getGitCommitSnapshot(projectPath, commitHash, {
			parent: parentHash,
			context: this.contextLines,
			bodyCandidateCount: BODY_CANDIDATE_COUNT,
			signal: controller.signal,
		})
			.then((result) => {
				if (!this.isCurrentGuard(guard, controller.signal)) return;
				if (result.status === 'not-found') {
					this.commitError = result.message;
					this.commitSnapshot = null;
					return;
				}
				this.selectedCommitHash = result.commit.hash;
				this.selectedParentHash = result.selectedParent;
				guard.commitHash = result.commit.hash;
				guard.parentHash = result.selectedParent;
				this.commitSnapshot = result;
				this.requestBodies(projectPath, result.firstBodyCandidates);
			})
			.catch((error) => {
				if (isAbortError(error) || !this.isCurrentGuard(guard, controller.signal)) return;
				this.commitError = m.git_history_load_commit_failed({
					detail: error instanceof Error ? error.message : String(error),
				});
				this.commitSnapshot = null;
			})
			.finally(() => {
				if (this.isCurrentGuard(guard, controller.signal)) this.commitLoading = false;
			});
	}

	private requestBodies(projectPath: string, filePaths: string[]): void {
		const snapshot = this.commitSnapshot;
		if (!snapshot) return;
		const guard = this.createGuard(projectPath, this.commitGeneration);
		const uniquePaths = unique(filePaths).filter(Boolean);
		this.seedCachedBodies(uniquePaths, guard);
		const toFetch = uniquePaths.filter((filePath) => this.shouldLoadBody(filePath, guard));
		if (toFetch.length === 0) return;
		this.markLoading(toFetch, true);
		this.prioritizeBodyQueue(toFetch);
		this.pumpBodyQueue(projectPath, guard.generation);
	}

	private pumpBodyQueue(projectPath: string, generation: number): void {
		const snapshot = this.commitSnapshot;
		if (!snapshot || this.bodyAbort || this.pendingBodyQueue.length === 0) return;
		const guard = this.createGuard(projectPath, generation);
		if (guard.generation !== generation) return;
		const batchSize = snapshot.limits.maxBodyBatchFiles || 24;
		const batch = this.pendingBodyQueue
			.splice(0, batchSize)
			.filter((filePath) => this.shouldStartBodyLoad(filePath, guard));
		if (batch.length === 0) {
			this.pumpBodyQueue(projectPath, generation);
			return;
		}

		const controller = new AbortController();
		this.bodyAbort = controller;
		this.bodyBatchFiles = new Set(batch);

		void getGitCommitFileBodies(projectPath, snapshot.documentId, snapshot.commit.hash, batch, {
			parent: snapshot.selectedParent,
			context: this.contextLines,
			signal: controller.signal,
		})
			.then((result) => {
				if (!this.isCurrentGuard(guard, controller.signal)) return;
				const next = { ...this.fileBodies };
				for (const filePath of batch) {
					const file = this.summaryForFile(filePath);
					const body = result.files[filePath];
					if (!file || !body) continue;
					if (body.bodyFingerprint !== file.bodyFingerprint) {
						next[filePath] = {
							...body,
							bodyState: 'error',
							error: m.git_history_commit_diff_changed(),
						};
						continue;
					}
					this.cacheSet(file, guard, body);
					next[filePath] = body;
				}
				this.fileBodies = next;
			})
			.catch((error) => {
				if (isAbortError(error) || !this.isCurrentGuard(guard, controller.signal)) return;
				this.commitError = m.git_history_load_diff_rows_failed({
					detail: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				if (this.bodyAbort !== controller) return;
				this.bodyAbort = null;
				this.bodyBatchFiles = new Set();
				this.markLoading(batch, false);
				if (generation === this.commitGeneration) this.pumpBodyQueue(projectPath, generation);
			});
	}

	private createGuard(projectPath: string, generation: number): HistoryLoadGuard {
		return {
			generation,
			projectPath,
			commitHash: this.selectedCommitHash,
			parentHash: this.selectedParentHash,
			contextLines: this.contextLines,
		};
	}

	private isCurrentGuard(guard: HistoryLoadGuard, signal?: AbortSignal): boolean {
		if (signal?.aborted) return false;
		if (guard.generation !== this.commitGeneration) return false;
		if (guard.projectPath !== this.loadedProjectPath) return false;
		if (guard.commitHash !== this.selectedCommitHash) return false;
		if (guard.parentHash !== this.selectedParentHash) return false;
		return guard.contextLines === this.contextLines;
	}

	private isCurrentListRequest(
		generation: number,
		projectPath: string,
		signal: AbortSignal,
	): boolean {
		return (
			!signal.aborted &&
			generation === this.listGeneration &&
			projectPath === this.loadedProjectPath
		);
	}

	private summaryForFile(filePath: string): GitCommitFileSummary | null {
		return this.commitSnapshot?.files.find((file) => file.path === filePath) ?? null;
	}

	private shouldLoadBody(filePath: string, guard: HistoryLoadGuard): boolean {
		const file = this.summaryForFile(filePath);
		if (!file || file.bodyState !== 'unloaded') return false;
		if (this.fileBodies[filePath]) return false;
		if (this.cacheGet(file, guard)) return false;
		if (this.loadingBodies.has(filePath)) return false;
		if (this.pendingBodyQueue.includes(filePath)) return false;
		if (this.bodyBatchFiles.has(filePath)) return false;
		return true;
	}

	private shouldStartBodyLoad(filePath: string, guard: HistoryLoadGuard): boolean {
		const file = this.summaryForFile(filePath);
		if (!file || file.bodyState !== 'unloaded') return false;
		if (this.fileBodies[filePath]) return false;
		if (this.cacheGet(file, guard)) return false;
		if (this.bodyBatchFiles.has(filePath)) return false;
		return true;
	}

	private seedCachedBodies(filePaths: string[], guard: HistoryLoadGuard): void {
		const seeded: Record<string, GitCommitFileBody> = {};
		for (const filePath of filePaths) {
			const file = this.summaryForFile(filePath);
			if (!file || this.fileBodies[filePath]) continue;
			const cached = this.cacheGet(file, guard);
			if (cached) seeded[filePath] = cached;
		}
		if (Object.keys(seeded).length > 0) this.fileBodies = { ...this.fileBodies, ...seeded };
	}

	private prioritizeBodyQueue(filePaths: string[]): void {
		const requested = new Set(filePaths);
		const stalePending = this.pendingBodyQueue.filter((filePath) => !requested.has(filePath));
		this.pendingBodyQueue = [...filePaths, ...stalePending];
	}

	private markLoading(filePaths: string[], isLoading: boolean): void {
		const next = new Set(this.loadingBodies);
		for (const filePath of filePaths) {
			if (isLoading) next.add(filePath);
			else next.delete(filePath);
		}
		this.loadingBodies = next;
	}

	private cacheKey(file: GitCommitFileSummary, guard: HistoryLoadGuard): BodyCacheKey {
		return `${this.commitSnapshot?.documentId ?? ''}|${guard.commitHash ?? ''}|${guard.parentHash ?? ''}|${guard.contextLines}|${file.bodyFingerprint}|${file.path}`;
	}

	private cacheGet(file: GitCommitFileSummary, guard: HistoryLoadGuard): GitCommitFileBody | null {
		return this.bodyCache.get(this.cacheKey(file, guard)) ?? null;
	}

	private cacheSet(
		file: GitCommitFileSummary,
		guard: HistoryLoadGuard,
		body: GitCommitFileBody,
	): void {
		this.bodyCache.set(this.cacheKey(file, guard), body);
	}
}

function commitFileToReviewFile(file: GitCommitFileSummary): GitReviewFileSummary {
	return {
		path: file.path,
		...(file.originalPath ? { originalPath: file.originalPath } : {}),
		indexStatus: statusToIndexStatus(file.status),
		workTreeStatus: ' ',
		category: file.category,
		additions: file.additions,
		deletions: file.deletions,
		estimatedRows: file.estimatedRows,
		bodyState: file.bodyState,
		bodyFingerprint: file.bodyFingerprint,
		isGenerated: file.isGenerated,
		isBinary: file.isBinary,
		isTooLarge: file.isTooLarge,
		...(file.limitReason ? { limitReason: file.limitReason } : {}),
		...(file.limitMessage ? { limitMessage: file.limitMessage } : {}),
	};
}

function statusToIndexStatus(status: GitCommitFileSummary['status']): GitStatusCode {
	switch (status) {
		case 'added':
			return 'A';
		case 'deleted':
			return 'D';
		case 'renamed':
			return 'R';
		case 'copied':
			return 'C';
		case 'type-changed':
			return 'M';
		case 'modified':
			return 'M';
		default:
			return '?';
	}
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values));
}
