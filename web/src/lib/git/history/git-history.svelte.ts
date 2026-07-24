import {
	getGitCommitFileBodies,
	getGitCommitSnapshot,
	getGitHistoryCommits,
	type GitCommitFileBody,
	type GitCommitFileSummary,
	type GitCommitSnapshotReady,
	type GitHistoryCommitListItem,
} from '$lib/api/git.js';
import { GitDiffDocumentController } from '$lib/git/review/git-diff-document.svelte.js';
import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';
import * as m from '$lib/paraglide/messages.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';

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

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_CONTEXT_LINES = 5;
const BODY_CANDIDATE_COUNT = 8;

export class GitHistoryController {
	readonly document = new GitDiffDocumentController();
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
	listScrollTop = $state(0);

	private listAbort: AbortController | null = null;
	private commitAbort: AbortController | null = null;
	private listGeneration = 0;
	private commitGeneration = 0;
	private loadedProjectPath: string | null = null;
	private listInitialized = false;
	private documentRecoveryAttempted = false;

	get visibleFiles(): GitCommitFileSummary[] {
		return this.document.visibleFiles;
	}

	get rowSource() {
		return this.document.rowSource;
	}

	get scrollRequest(): { filePath: string; token: number } | null {
		return this.document.scrollRequest;
	}

	get fileFilter(): string {
		return this.document.fileFilter;
	}

	get focusedFilePath(): string | null {
		return this.document.focusedFilePath;
	}

	get fileBodies(): Record<string, GitCommitFileBody> {
		return this.document.fileBodies;
	}

	get diffMode(): DiffMode {
		return this.document.diffMode;
	}

	get contextLines(): number {
		return this.document.contextLines;
	}

	setDisplayOptions(projectPath: string | null, diffMode: DiffMode, contextLines: number): void {
		const normalizedContext = Number.isFinite(contextLines)
			? Math.max(0, Math.round(contextLines))
			: DEFAULT_CONTEXT_LINES;
		const contextChanged = this.document.contextLines !== normalizedContext;
		if (contextChanged && this.document.commentComposer.open) {
			this.document.markContextChangeBlocked();
			return;
		}
		this.document.setDisplayOptions(diffMode, normalizedContext);
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
		this.listInitialized = false;

		void getGitHistoryCommits(projectPath, {
			limit: DEFAULT_HISTORY_LIMIT,
			offset: 0,
			signal: controller.signal,
		})
			.then((result) => {
				if (!this.isCurrentListRequest(generation, projectPath, controller.signal)) return;
				this.commits = result.commits;
				this.nextOffset = result.nextOffset;
				this.listInitialized = true;
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
				this.listInitialized = true;
			})
			.finally(() => {
				if (this.isCurrentListRequest(generation, projectPath, controller.signal)) {
					this.listLoading = false;
				}
			});
	}

	ensureInitialLoaded(projectPath: string): void {
		if (this.loadedProjectPath === projectPath && (this.listInitialized || this.listLoading)) {
			return;
		}
		this.loadInitial(projectPath);
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
		this.loadCommitSnapshot(projectPath, commitHash, null);
	}

	backToList(): void {
		this.screen = 'list';
		this.commitAbort?.abort();
		this.document.clear({ preserveCache: true });
		this.commitLoading = false;
		this.documentRecoveryAttempted = false;
	}

	selectParent(projectPath: string, parentHash: string | null): void {
		if (!this.selectedCommitHash || parentHash === this.selectedParentHash) return;
		this.selectedParentHash = parentHash;
		this.loadCommitSnapshot(projectPath, this.selectedCommitHash, parentHash);
	}

	focusFile(_projectPath: string, filePath: string): void {
		this.document.focusFile(filePath);
	}

	setVisibleRows(_projectPath: string, rows: GitVirtualReviewRow[]): void {
		this.document.setVisibleRows(rows);
	}

	setFileFilter(value: string): void {
		this.document.setFileFilter(value);
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
		this.listAbort = null;
		this.commitAbort = null;
		this.document.clear();
		this.listGeneration += 1;
		this.commitGeneration += 1;
		this.loadedProjectPath = projectPath;
		this.listInitialized = false;
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
		this.documentRecoveryAttempted = false;
		this.listScrollTop = 0;
	}

	private loadCommitSnapshot(
		projectPath: string,
		commitHash: string,
		parentHash: string | null,
		isDocumentRecovery = false,
	): void {
		if (!isDocumentRecovery) this.documentRecoveryAttempted = false;
		this.commitAbort?.abort();
		this.document.clear({ preserveCache: true });
		this.commitSnapshot = null;
		this.commitError = null;
		this.commitLoading = true;
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
				this.document.open(result, {
					contextLines: this.contextLines,
					diffMode: this.diffMode,
					commentSource: {
						kind: 'commit',
						shortHash: result.commit.shortHash,
						subject: result.commit.subject,
						baseLabel: result.selectedParent
							? `parent ${result.selectedParent.slice(0, 10)}`
							: 'the empty tree',
					},
					loadBodies: (_snapshot, files, purpose, signal) =>
						getGitCommitFileBodies(projectPath, result.documentId, result.commit.hash, files, {
							parent: result.selectedParent,
							context: this.contextLines,
							purpose,
							signal,
						}),
					onError: (detail) => {
						this.commitError = m.git_history_load_diff_rows_failed({ detail });
					},
					onExpired: (message) => {
						if (this.documentRecoveryAttempted) {
							this.commitError = message;
							return;
						}
						this.documentRecoveryAttempted = true;
						this.loadCommitSnapshot(
							projectPath,
							result.commit.hash,
							result.selectedParent,
							true,
						);
					},
				});
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
		return (
			!signal?.aborted &&
			guard.generation === this.commitGeneration &&
			guard.projectPath === this.loadedProjectPath &&
			guard.commitHash === this.selectedCommitHash &&
			guard.parentHash === this.selectedParentHash &&
			guard.contextLines === this.contextLines
		);
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
}
