import type {
	GitCommitFileSummary,
	GitDiffFileRequest,
	GitReviewCollectionLimit,
	GitReviewDocumentLimits,
	GitReviewFileBodiesResponse,
	GitReviewFileBody,
	GitReviewFileSummary,
	GitStatusCode,
} from '$lib/api/git.js';
import type { GitComparisonFileBodiesResponse } from '$lib/api/git-comparison.js';
import {
	GitInlineCommentState,
	type CommentComposerState,
	type GitDiffSeverity,
} from '$lib/git/review/git-inline-comment.svelte.js';
import {
	buildVirtualRows,
	type GitVirtualReviewRow,
} from '$lib/git/review/git-virtual-review-document.svelte.js';
import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';
import type {
	ChatDraftAppend,
	ChatDraftAppendResult,
} from '$lib/chat/composer/chat-draft-append.js';
import {
	buildGitReviewCommentMessage,
	type GitReviewCommentSource,
} from '$lib/git/review/git-review-comment-message.js';
import { buildGitReviewCommentContext } from '$lib/git/review/git-review-comment-context.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import * as m from '$lib/paraglide/messages.js';

export interface GitDiffDocumentSnapshot {
	project: string;
	documentId: string;
	files: GitCommitFileSummary[];
	limits: GitReviewDocumentLimits;
	collectionLimit?: GitReviewCollectionLimit;
	firstBodyCandidates: string[];
}

export type GitDiffDocumentBodyResponse =
	GitReviewFileBodiesResponse | GitComparisonFileBodiesResponse;

export type GitDiffDocumentBodyLoader = (
	snapshot: GitDiffDocumentSnapshot,
	files: GitDiffFileRequest[],
	signal: AbortSignal,
) => Promise<GitDiffDocumentBodyResponse>;

export interface GitDiffDocumentOpenOptions {
	contextLines: number;
	diffMode: DiffMode;
	loadBodies: GitDiffDocumentBodyLoader;
	onError: (message: string) => void;
	onStale?: (message: string) => void;
	commentSource?: GitReviewCommentSource;
}

export class GitDiffDocumentController {
	readonly inlineComment = new GitInlineCommentState();
	snapshot = $state<GitDiffDocumentSnapshot | null>(null);
	fileBodies = $state<Record<string, GitReviewFileBody>>({});
	loadingBodies = $state(new Set<string>());
	scrollRequest = $state<{ filePath: string; token: number } | null>(null);
	fileFilter = $state('');
	focusedFilePath = $state<string | null>(null);
	diffMode = $state<DiffMode>('unified');
	contextLines = $state(5);
	aggregateLimit = $state<GitReviewCollectionLimit | null>(null);
	isStale = $state(false);
	staleMessage = $state<string | null>(null);

	private bodyAbort: AbortController | null = null;
	private bodyBatchFiles = new Set<string>();
	private pendingBodyQueue: string[] = [];
	private summariesByPath = new Map<string, GitCommitFileSummary>();
	private bodyCache = new Map<string, GitReviewFileBody>();
	private bodyCacheBytes = 0;
	private generation = 0;
	private scrollToken = 0;
	private loadBodies: GitDiffDocumentBodyLoader | null = null;
	private onError: ((message: string) => void) | null = null;
	private onStale: ((message: string) => void) | null = null;
	private commentSource: GitReviewCommentSource | null = null;

	get commentComposer(): CommentComposerState {
		return this.inlineComment.composer;
	}

	get commentFeedback() {
		return this.inlineComment.feedback;
	}

	get commentError(): string | null {
		return this.inlineComment.error;
	}

	get commentCopyText(): string | null {
		return this.inlineComment.copyText;
	}

	visibleFiles = $derived.by<GitCommitFileSummary[]>(() => {
		const snapshot = this.snapshot;
		if (!snapshot) return [];
		const filter = this.fileFilter.trim().toLowerCase();
		if (!filter) return snapshot.files;
		return snapshot.files.filter((file) =>
			[file.path, file.originalPath ?? '', file.status, file.rawStatus, file.category].some(
				(value) => value.toLowerCase().includes(filter),
			),
		);
	});

	private virtualSummary = $derived.by(() => {
		const snapshot = this.snapshot;
		if (!snapshot) return null;
		const collectionLimit = this.aggregateLimit ?? snapshot.collectionLimit;
		return {
			documentId: snapshot.documentId,
			project: snapshot.project,
			context: this.contextLines,
			files: this.visibleFiles.map(commitFileToReviewFile),
			limits: snapshot.limits,
			...(collectionLimit ? { collectionLimit } : {}),
		};
	});

	virtualRows = $derived.by<GitVirtualReviewRow[]>(() => {
		const summary = this.virtualSummary;
		if (!summary) return [];
		let rows = buildVirtualRows({
			summary,
			visibleFilePaths: summary.files.map((file) => file.path),
			fileBodies: this.fileBodies,
			loadingBodies: this.loadingBodies,
			focusedFilePath: this.focusedFilePath,
			diffMode: this.diffMode,
			contextLines: this.contextLines,
			interaction: this.commentSource
				? { kind: 'commentable', composerState: this.commentComposer }
				: { kind: 'read-only' },
		});
		const aggregateLimit = this.aggregateLimit;
		if (aggregateLimit) {
			rows = rows.map((row) =>
				row.kind === 'file-placeholder'
					? {
							kind: 'file-limit' as const,
							id: `${summary.documentId}:file:${encodeURIComponent(row.filePath)}:limit:${aggregateLimit.reason}`,
							filePath: row.filePath,
							estimatedHeight: 112,
							file: row.file,
							title: m.git_virtual_diff_limit_reached(),
							message: aggregateLimit.message,
							reason: aggregateLimit.reason,
						}
					: row,
			);
		}
		if (!this.isStale) return rows;
		return rows.map((row) =>
			row.kind === 'file-placeholder'
				? {
						kind: 'file-limit' as const,
						id: `${summary.documentId}:file:${encodeURIComponent(row.filePath)}:limit:stale-document`,
						filePath: row.filePath,
						estimatedHeight: 112,
						file: row.file,
						title: m.git_virtual_stale_diff(),
						message: this.staleMessage ?? m.git_virtual_stale_diff_message(),
						reason: 'stale-document' as const,
					}
				: row,
		);
	});

	fileRowIndex = $derived.by(() => {
		const index = new Map<string, number>();
		this.virtualRows.forEach((row, rowIndex) => {
			if (row.kind === 'file-header') index.set(row.filePath, rowIndex);
		});
		return index;
	});

	open(snapshot: GitDiffDocumentSnapshot, options: GitDiffDocumentOpenOptions): void {
		this.bodyAbort?.abort();
		this.bodyAbort = null;
		this.generation += 1;
		this.snapshot = snapshot;
		this.summariesByPath = new Map(snapshot.files.map((file) => [file.path, file]));
		this.loadBodies = options.loadBodies;
		this.onError = options.onError;
		this.onStale = options.onStale ?? null;
		this.commentSource = options.commentSource ?? null;
		this.diffMode = options.diffMode;
		this.contextLines = options.contextLines;
		this.fileBodies = {};
		this.seedCachedBodies(snapshot.files.map((file) => file.path));
		this.loadingBodies = new Set();
		this.bodyBatchFiles = new Set();
		this.pendingBodyQueue = [];
		this.scrollRequest = null;
		this.fileFilter = '';
		this.focusedFilePath = null;
		this.aggregateLimit = null;
		this.isStale = false;
		this.staleMessage = null;
		this.closeCommentComposer();
		this.clearCommentFeedback();
		this.requestBodies(snapshot.firstBodyCandidates);
	}

	setDisplayOptions(diffMode: DiffMode, contextLines: number): void {
		this.diffMode = diffMode;
		this.contextLines = contextLines;
	}

	focusFile(filePath: string): void {
		this.focusedFilePath = filePath;
		this.requestBodies([filePath]);
		this.scrollToken += 1;
		this.scrollRequest = { filePath, token: this.scrollToken };
	}

	setVisibleRows(rows: GitVirtualReviewRow[]): void {
		this.requestBodies(Array.from(new Set(rows.map((row) => row.filePath).filter(Boolean))));
	}

	setFileFilter(value: string): void {
		this.fileFilter = value;
	}

	openCommentComposer(filePath: string, side: 'before' | 'after', line: number): void {
		if (!this.commentSource) return;
		this.inlineComment.open(filePath, side, line);
	}

	markCommentComposerFocused(): void {
		this.inlineComment.markFocused();
	}

	setCommentBody(body: string): void {
		this.inlineComment.setBody(body);
	}

	setCommentSeverity(severity: GitDiffSeverity): void {
		this.inlineComment.setSeverity(severity);
	}

	submitComment(append: ChatDraftAppend | undefined): ChatDraftAppendResult {
		const composer = this.commentComposer;
		const source = this.commentSource;
		if (!this.inlineComment.canSubmit || !source) {
			return 'unavailable';
		}
		const file = this.summaryForFile(composer.filePath);
		const body = this.fileBodies[composer.filePath];
		const block = buildGitReviewCommentMessage({
			source,
			filePath: composer.filePath,
			...(file?.originalPath ? { originalPath: file.originalPath } : {}),
			side: composer.side,
			line: composer.line,
			contextLines: buildGitReviewCommentContext(body?.rows ?? [], composer.side, composer.line),
			body: composer.body,
			severity: composer.severity,
		});
		return this.inlineComment.appendBlock(append, block);
	}

	closeCommentComposer(): void {
		this.inlineComment.close();
	}

	clearCommentFeedback(): void {
		this.inlineComment.clearFeedback();
	}

	markStale(message?: string): void {
		this.bodyAbort?.abort();
		this.bodyAbort = null;
		this.isStale = true;
		this.staleMessage = message ?? m.git_virtual_stale_diff_message();
		this.pendingBodyQueue = [];
		this.bodyBatchFiles = new Set();
		this.loadingBodies = new Set();
		if (message) this.onStale?.(message);
	}

	clear(options: { preserveCache?: boolean } = {}): void {
		this.bodyAbort?.abort();
		this.bodyAbort = null;
		this.generation += 1;
		this.snapshot = null;
		this.summariesByPath.clear();
		this.fileBodies = {};
		this.loadingBodies = new Set();
		this.bodyBatchFiles = new Set();
		this.pendingBodyQueue = [];
		this.scrollRequest = null;
		this.fileFilter = '';
		this.focusedFilePath = null;
		this.aggregateLimit = null;
		this.isStale = false;
		this.staleMessage = null;
		this.closeCommentComposer();
		this.clearCommentFeedback();
		this.loadBodies = null;
		this.onError = null;
		this.onStale = null;
		this.commentSource = null;
		if (!options.preserveCache) this.clearBodyCache();
	}

	private requestBodies(filePaths: string[]): void {
		const snapshot = this.snapshot;
		if (!snapshot || !this.loadBodies || this.aggregateLimit || this.isStale) return;
		const uniquePaths = Array.from(new Set(filePaths)).filter(Boolean);
		this.seedCachedBodies(uniquePaths);
		const toFetch = uniquePaths.filter((filePath) => this.shouldLoadBody(filePath));
		if (toFetch.length === 0) return;
		this.markLoading(toFetch, true);
		const requested = new Set(toFetch);
		this.pendingBodyQueue = [
			...toFetch,
			...this.pendingBodyQueue.filter((filePath) => !requested.has(filePath)),
		];
		this.pumpBodyQueue(this.generation);
	}

	private pumpBodyQueue(generation: number): void {
		const snapshot = this.snapshot;
		const loadBodies = this.loadBodies;
		if (!snapshot || !loadBodies || this.bodyAbort || this.pendingBodyQueue.length === 0) return;
		if (generation !== this.generation || this.aggregateLimit) return;
		const batch = this.pendingBodyQueue
			.splice(0, snapshot.limits.maxBodyBatchFiles || 24)
			.filter((filePath) => this.shouldStartBodyLoad(filePath));
		if (batch.length === 0) {
			this.pumpBodyQueue(generation);
			return;
		}

		const controller = new AbortController();
		this.bodyAbort = controller;
		this.bodyBatchFiles = new Set(batch);
		const requests = batch.map((path) => {
			const summary = this.summaryForFile(path);
			return { path, ...(summary?.originalPath ? { originalPath: summary.originalPath } : {}) };
		});

		void loadBodies(snapshot, requests, controller.signal)
			.then((result) => {
				if (!this.isCurrent(generation, snapshot.documentId, controller.signal)) return;
				if ('status' in result && result.status === 'stale') {
					this.markStale(result.message);
					return;
				}
				const next = { ...this.fileBodies };
				for (const filePath of batch) {
					const file = this.summaryForFile(filePath);
					const body = result.files[filePath];
					if (!file || !body) continue;
					if (body.bodyState === 'error') {
						next[filePath] = body;
						continue;
					}
					if (body.bodyFingerprint !== file.bodyFingerprint) {
						next[filePath] = {
							...body,
							bodyState: 'error',
							error: m.git_diff_document_changed(),
						};
						continue;
					}
					const limited = this.acceptWithinBudget(body, snapshot.limits, next);
					next[filePath] = limited;
					if (limited === body) this.cacheBody(file, body, snapshot.limits.maxLoadedPatchBytes);
					if (this.aggregateLimit) break;
				}
				this.fileBodies = next;
			})
			.catch((error) => {
				if (
					isAbortError(error) ||
					!this.isCurrent(generation, snapshot.documentId, controller.signal)
				) {
					return;
				}
				this.onError?.(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (this.bodyAbort !== controller) return;
				this.bodyAbort = null;
				this.bodyBatchFiles = new Set();
				this.markLoading(batch, false);
				if (generation === this.generation) this.pumpBodyQueue(generation);
			});
	}

	private acceptWithinBudget(
		body: GitReviewFileBody,
		limits: GitReviewDocumentLimits,
		acceptedBodies: Record<string, GitReviewFileBody>,
	): GitReviewFileBody {
		if (body.bodyState !== 'loaded') return body;
		const loaded = Object.values(acceptedBodies).filter(
			(candidate) => candidate.bodyState === 'loaded',
		);
		const loadedRows = loaded.reduce((total, candidate) => total + candidate.renderedRowCount, 0);
		const loadedBytes = loaded.reduce((total, candidate) => total + candidate.patchBytes, 0);
		const rowsExceeded = loadedRows + body.renderedRowCount > limits.maxLoadedRows;
		const bytesExceeded = loadedBytes + body.patchBytes > limits.maxLoadedPatchBytes;
		if (!rowsExceeded && !bytesExceeded) return body;

		this.pendingBodyQueue = [];
		this.loadingBodies = new Set();
		const reason = rowsExceeded ? 'collection-too-many-rows' : 'collection-too-many-bytes';
		const message = rowsExceeded
			? `Stopped loading after ${loadedRows.toLocaleString()} rendered rows.`
			: `Stopped loading after ${loadedBytes.toLocaleString()} patch bytes.`;
		this.aggregateLimit = {
			reason,
			message,
			visibleFiles: Object.keys(acceptedBodies).length,
			totalFilesKnown: this.snapshot?.files.length ?? 0,
		};
		return {
			...body,
			bodyState: 'too-large',
			category: 'large',
			isTooLarge: true,
			renderedRowCount: 0,
			patchBytes: 0,
			rows: [],
			hunks: [],
			limitReason: reason,
			limitMessage: message,
		};
	}

	private isCurrent(generation: number, documentId: string, signal: AbortSignal): boolean {
		return (
			!signal.aborted && generation === this.generation && this.snapshot?.documentId === documentId
		);
	}

	private summaryForFile(filePath: string): GitCommitFileSummary | null {
		return this.summariesByPath.get(filePath) ?? null;
	}

	private shouldLoadBody(filePath: string): boolean {
		const file = this.summaryForFile(filePath);
		if (!file || file.bodyState !== 'unloaded') return false;
		if (this.fileBodies[filePath] || this.bodyCache.has(this.cacheKey(file))) return false;
		if (this.loadingBodies.has(filePath) || this.pendingBodyQueue.includes(filePath)) return false;
		return !this.bodyBatchFiles.has(filePath);
	}

	private shouldStartBodyLoad(filePath: string): boolean {
		const file = this.summaryForFile(filePath);
		if (!file || file.bodyState !== 'unloaded') return false;
		if (this.fileBodies[filePath] || this.bodyCache.has(this.cacheKey(file))) return false;
		return !this.bodyBatchFiles.has(filePath);
	}

	private seedCachedBodies(filePaths: string[]): void {
		if (this.bodyCache.size === 0) return;
		const seeded: Record<string, GitReviewFileBody> = {};
		for (const filePath of filePaths) {
			const file = this.summaryForFile(filePath);
			if (!file || this.fileBodies[filePath]) continue;
			const key = this.cacheKey(file);
			const cached = this.bodyCache.get(key);
			if (cached) {
				this.bodyCache.delete(key);
				this.bodyCache.set(key, cached);
				seeded[filePath] = cached;
			}
		}
		if (Object.keys(seeded).length > 0) this.fileBodies = { ...this.fileBodies, ...seeded };
	}

	private markLoading(filePaths: string[], isLoading: boolean): void {
		const next = new Set(this.loadingBodies);
		for (const filePath of filePaths) {
			if (isLoading) next.add(filePath);
			else next.delete(filePath);
		}
		this.loadingBodies = next;
	}

	private cacheKey(file: GitCommitFileSummary): string {
		return `${this.snapshot?.documentId ?? ''}|${file.bodyFingerprint}|${file.path}`;
	}

	private cacheBody(file: GitCommitFileSummary, body: GitReviewFileBody, byteLimit: number): void {
		const key = this.cacheKey(file);
		const existing = this.bodyCache.get(key);
		if (existing) this.bodyCacheBytes -= existing.patchBytes;
		this.bodyCache.delete(key);
		this.bodyCache.set(key, body);
		this.bodyCacheBytes += body.patchBytes;
		while (this.bodyCacheBytes > byteLimit && this.bodyCache.size > 0) {
			const oldestKey = this.bodyCache.keys().next().value;
			if (oldestKey === undefined) break;
			const evicted = this.bodyCache.get(oldestKey);
			this.bodyCache.delete(oldestKey);
			this.bodyCacheBytes -= evicted?.patchBytes ?? 0;
		}
	}

	private clearBodyCache(): void {
		this.bodyCache.clear();
		this.bodyCacheBytes = 0;
	}
}

export function commitFileToReviewFile(file: GitCommitFileSummary): GitReviewFileSummary {
	return {
		path: file.path,
		...(file.originalPath ? { originalPath: file.originalPath } : {}),
		indexStatus: statusToIndexStatus(file.status),
		workTreeStatus: ' ',
		category: file.category,
		additions: file.additions,
		deletions: file.deletions,
		...(file.statsKnown !== undefined ? { statsKnown: file.statsKnown } : {}),
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
			return 'T';
		case 'modified':
			return 'M';
		default:
			return '?';
	}
}
