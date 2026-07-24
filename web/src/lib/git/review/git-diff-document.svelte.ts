import type {
	GitCommitFileSummary,
	GitDiffFileRequest,
	GitReviewCollectionLimit,
	GitReviewDocumentLimits,
	GitReviewDocumentIndexedFileBodiesResponse,
	GitReviewBodyPurpose,
	GitReviewFileBody,
	GitReviewFileSummary,
	GitStatusCode,
} from '$lib/api/git.js';
import {
	GitInlineCommentState,
	type CommentComposerState,
	type GitDiffSeverity,
} from '$lib/git/review/git-inline-comment.svelte.js';
import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';
import type {
	ChatDraftAppend,
	ChatDraftAppendResult,
} from '$lib/chat/composer/chat-draft-append.js';
import {
	buildGitReviewCommentMessage,
	type GitReviewCommentSource,
} from '$lib/git/review/git-review-comment-message.js';
import { buildGitReviewBodyCommentContext } from '$lib/git/review/git-review-comment-context.js';
import { GitReviewBodyScheduler } from './git-review-body-scheduler.js';
import {
	collectionLimitDecisionFromGitReviewBody,
	decideGitReviewBodyBudget,
	type GitReviewBodyBudgetDecision,
} from './git-review-body-budget.js';
import {
	buildGitVirtualReviewRowSource,
	emptyGitVirtualReviewRowSource,
	type GitVirtualReviewRowSource,
} from './git-virtual-review-row-source.js';
import * as m from '$lib/paraglide/messages.js';

const MAX_CACHED_FILE_BODIES = 128;

export interface GitDiffDocumentSnapshot {
	project: string;
	documentId: string;
	files: GitCommitFileSummary[];
	limits: GitReviewDocumentLimits;
	collectionLimit?: GitReviewCollectionLimit;
	firstBodyCandidates: string[];
}

export type GitDiffDocumentBodyResponse = GitReviewDocumentIndexedFileBodiesResponse;

export type GitDiffDocumentBodyLoader = (
	snapshot: GitDiffDocumentSnapshot,
	files: GitDiffFileRequest[],
	purpose: GitReviewBodyPurpose,
	signal: AbortSignal,
) => Promise<GitDiffDocumentBodyResponse>;

export interface GitDiffDocumentOpenOptions {
	contextLines: number;
	diffMode: DiffMode;
	loadBodies: GitDiffDocumentBodyLoader;
	onError: (message: string) => void;
	onBodyLoadSuccess?: () => void;
	onStale?: (message: string) => void;
	onExpired?: (message: string) => void;
	commentSource?: GitReviewCommentSource;
}

export class GitDiffDocumentController {
	readonly inlineComment = new GitInlineCommentState();
	snapshot = $state<GitDiffDocumentSnapshot | null>(null);
	fileBodies = $state.raw<Record<string, GitReviewFileBody>>({});
	loadingBodies = $state(new Set<string>());
	scrollRequest = $state<{ filePath: string; token: number } | null>(null);
	fileFilter = $state('');
	focusedFilePath = $state<string | null>(null);
	diffMode = $state<DiffMode>('unified');
	contextLines = $state(5);
	aggregateLimit = $state<GitReviewCollectionLimit | null>(null);
	isStale = $state(false);
	staleMessage = $state<string | null>(null);

	private bodyScheduler: GitReviewBodyScheduler<GitDiffDocumentBodyResponse> | null = null;
	private summariesByPath = new Map<string, GitCommitFileSummary>();
	private bodyCache = new Map<string, GitReviewFileBody>();
	private bodyPurposes = new Map<string, GitReviewBodyPurpose>();
	private bodyCacheBytes = 0;
	private prefetchStopped = false;
	private generation = 0;
	private scrollToken = 0;
	private onError: ((message: string) => void) | null = null;
	private onBodyLoadSuccess: (() => void) | null = null;
	private onStale: ((message: string) => void) | null = null;
	private onExpired: ((message: string) => void) | null = null;
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
			const collectionLimit = snapshot.collectionLimit ?? this.aggregateLimit;
		return {
			documentId: snapshot.documentId,
			project: snapshot.project,
			context: this.contextLines,
			files: this.visibleFiles.map(commitFileToReviewFile),
			limits: snapshot.limits,
			...(collectionLimit ? { collectionLimit } : {}),
		};
	});

	rowSource = $derived.by<GitVirtualReviewRowSource>(() => {
		const summary = this.virtualSummary;
		if (!summary) return emptyGitVirtualReviewRowSource();
		const placeholderLimit = this.aggregateLimit
			? {
					title: m.git_virtual_diff_limit_reached(),
					message: this.aggregateLimit.message,
					reason: this.aggregateLimit.reason,
				}
			: this.isStale
				? {
						title: m.git_virtual_stale_diff(),
						message: this.staleMessage ?? m.git_virtual_stale_diff_message(),
						reason: 'stale-document' as const,
					}
				: undefined;
		return buildGitVirtualReviewRowSource({
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
			...(placeholderLimit ? { placeholderLimit } : {}),
		});
	});

	open(snapshot: GitDiffDocumentSnapshot, options: GitDiffDocumentOpenOptions): void {
		this.bodyScheduler?.cancel();
		this.generation += 1;
		this.snapshot = snapshot;
		this.summariesByPath = new Map(snapshot.files.map((file) => [file.path, file]));
		this.onError = options.onError;
		this.onBodyLoadSuccess = options.onBodyLoadSuccess ?? null;
		this.onStale = options.onStale ?? null;
		this.onExpired = options.onExpired ?? null;
		this.commentSource = options.commentSource ?? null;
		this.diffMode = options.diffMode;
		this.contextLines = options.contextLines;
		this.fileBodies = {};
		this.bodyPurposes.clear();
		this.prefetchStopped = false;
		this.loadingBodies = new Set();
		this.scrollRequest = null;
		this.fileFilter = '';
		this.focusedFilePath = null;
		this.aggregateLimit = null;
		this.isStale = false;
		this.staleMessage = null;
		this.closeCommentComposer();
		this.clearCommentFeedback();
		const generation = this.generation;
		this.bodyScheduler = new GitReviewBodyScheduler({
			maxBatchFiles: snapshot.limits.maxBodyBatchFiles || 24,
			load: (paths, purpose, signal) => {
				const requests = paths.map((path) => {
					const summary = this.summaryForFile(path);
					return { path, ...(summary?.originalPath ? { originalPath: summary.originalPath } : {}) };
				});
				return options.loadBodies(snapshot, requests, purpose, signal);
			},
			onResult: (result, paths, purpose) =>
				this.applyBodyResult(result, paths, purpose, generation, snapshot),
			onError: (error) =>
				this.onError?.(error instanceof Error ? error.message : String(error)),
			onLoadingChange: (paths, loading) => this.markLoading(paths, loading),
		});
		const [priority, ...prefetch] = snapshot.firstBodyCandidates;
		if (priority) this.requestBodies([priority], 'visible');
		this.requestBodies(prefetch, 'prefetch');
	}

	setDisplayOptions(diffMode: DiffMode, contextLines: number): void {
		this.diffMode = diffMode;
		this.contextLines = contextLines;
	}

	focusFile(filePath: string): void {
		this.focusedFilePath = filePath;
		this.requestBodies([filePath], 'visible');
		this.scrollToken += 1;
		this.scrollRequest = { filePath, token: this.scrollToken };
	}

	setVisibleRows(rows: GitVirtualReviewRow[]): void {
		this.requestBodies(
			Array.from(new Set(rows.map((row) => row.filePath).filter(Boolean))),
			'visible',
		);
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

	markContextChangeBlocked(): void {
		this.inlineComment.markContextChangeBlocked();
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
			contextLines: buildGitReviewBodyCommentContext(body, composer.side, composer.line),
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
		this.bodyScheduler?.cancel();
		this.isStale = true;
		this.staleMessage = message ?? m.git_virtual_stale_diff_message();
		this.loadingBodies = new Set();
		if (message) this.onStale?.(message);
	}

	clear(options: { preserveCache?: boolean } = {}): void {
		this.bodyScheduler?.cancel();
		this.bodyScheduler = null;
		this.generation += 1;
		this.snapshot = null;
		this.summariesByPath.clear();
		this.fileBodies = {};
		this.bodyPurposes.clear();
		this.prefetchStopped = false;
		this.loadingBodies = new Set();
		this.scrollRequest = null;
		this.fileFilter = '';
		this.focusedFilePath = null;
		this.aggregateLimit = null;
		this.isStale = false;
		this.staleMessage = null;
		this.closeCommentComposer();
		this.clearCommentFeedback();
		this.onError = null;
		this.onBodyLoadSuccess = null;
		this.onStale = null;
		this.onExpired = null;
		this.commentSource = null;
		if (!options.preserveCache) this.clearBodyCache();
	}

	private requestBodies(filePaths: string[], purpose: GitReviewBodyPurpose): void {
		const snapshot = this.snapshot;
		if (!snapshot || !this.bodyScheduler || this.aggregateLimit || this.isStale) return;
		if (purpose === 'prefetch' && this.prefetchStopped) return;
		const uniquePaths = Array.from(new Set(filePaths)).filter(Boolean);
		this.seedCachedBodies(uniquePaths, purpose);
		const toFetch = uniquePaths.filter((filePath) => this.shouldLoadBody(filePath));
		if (toFetch.length === 0) return;
		if (purpose === 'visible') this.bodyScheduler.requestVisible(toFetch);
		else this.bodyScheduler.requestPrefetch(toFetch);
	}

	private applyBodyResult(
		result: GitDiffDocumentBodyResponse,
		paths: string[],
		purpose: GitReviewBodyPurpose,
		generation: number,
		snapshot: GitDiffDocumentSnapshot,
	): void {
		if (!this.isCurrent(generation, snapshot.documentId)) return;
		if (
			'status' in result &&
			(result.status === 'stale' || result.status === 'document-expired')
		) {
			this.markStale(result.message);
			if (result.status === 'document-expired') this.onExpired?.(result.message);
			return;
		}
		this.onBodyLoadSuccess?.();
		const next = { ...this.fileBodies };
		for (const filePath of paths) {
			const file = this.summaryForFile(filePath);
			const body = result.files[filePath];
			if (!file || !body) continue;
			if (body.bodyState === 'error') {
				next[filePath] = body;
				continue;
			}
			if (body.bodyFingerprint !== file.bodyFingerprint) {
				next[filePath] = {
					path: body.path,
					bodyFingerprint: body.bodyFingerprint,
					bodyState: 'error',
					category: body.category,
					isBinary: false,
					isTooLarge: false,
					renderedRowCount: 0,
					patchBytes: 0,
					patch: null,
					patchIndex: null,
					error: m.git_diff_document_changed(),
				};
				continue;
			}
			const serverLimit = collectionLimitDecisionFromGitReviewBody(body, next);
			if (serverLimit) {
				next[filePath] = body;
				this.setAggregateLimit(
					serverLimit,
					Object.keys(next).length,
					body.limitMessage,
				);
				break;
			}
			const decision = decideGitReviewBodyBudget(
				body,
				purpose,
				next,
				this.bodyPurposes,
				snapshot.limits,
			);
			this.evictActiveBodies(next, decision);
			if (!decision.accept) {
				if (purpose === 'prefetch') {
					this.stopPrefetch();
					break;
				}
				next[filePath] = this.collectionLimitBody(body, decision);
				this.setAggregateLimit(decision, Object.keys(next).length);
				break;
			}
			next[filePath] = body;
			this.bodyPurposes.set(filePath, purpose);
			if (body.bodyState === 'loaded') {
				this.cacheBody(file, body, snapshot.limits.maxLoadedPatchBytes);
			}
		}
		this.fileBodies = next;
	}

	private collectionLimitBody(
		body: GitReviewFileBody,
		decision: GitReviewBodyBudgetDecision,
	): GitReviewFileBody {
		const reason = decision.reason ?? 'collection-too-many-rows';
		const message = this.aggregateLimitMessage(decision);
		return {
			path: body.path,
			bodyFingerprint: body.bodyFingerprint,
			bodyState: 'too-large',
			category: 'large',
			isBinary: false,
			isTooLarge: true,
			renderedRowCount: 0,
			patchBytes: 0,
			patch: null,
			patchIndex: null,
			limitReason: reason,
			limitMessage: message,
		};
	}

	private setAggregateLimit(
		decision: GitReviewBodyBudgetDecision,
		visibleFiles: number,
		message = this.aggregateLimitMessage(decision),
	): void {
		this.bodyScheduler?.cancel();
		this.loadingBodies = new Set();
		this.aggregateLimit = {
			reason: decision.reason ?? 'collection-too-many-rows',
			message,
			visibleFiles,
			totalFilesKnown: this.snapshot?.files.length ?? 0,
		};
	}

	private aggregateLimitMessage(decision: GitReviewBodyBudgetDecision): string {
		return decision.reason === 'collection-too-many-bytes'
			? `Stopped loading after ${decision.loadedBytes.toLocaleString()} patch bytes.`
			: `Stopped loading after ${decision.loadedRows.toLocaleString()} rendered rows.`;
	}

	private evictActiveBodies(
		bodies: Record<string, GitReviewFileBody>,
		decision: GitReviewBodyBudgetDecision,
	): void {
		for (const path of decision.evictedPaths) {
			delete bodies[path];
			this.bodyPurposes.delete(path);
		}
	}

	private stopPrefetch(): void {
		this.prefetchStopped = true;
		this.bodyScheduler?.cancelPrefetch();
	}

	private isCurrent(generation: number, documentId: string): boolean {
		return generation === this.generation && this.snapshot?.documentId === documentId;
	}

	private summaryForFile(filePath: string): GitCommitFileSummary | null {
		return this.summariesByPath.get(filePath) ?? null;
	}

	private shouldLoadBody(filePath: string): boolean {
		const file = this.summaryForFile(filePath);
		if (!file || file.bodyState !== 'unloaded') return false;
		if (this.fileBodies[filePath] || this.bodyCache.has(this.cacheKey(file))) return false;
		return !this.loadingBodies.has(filePath);
	}

	private seedCachedBodies(filePaths: string[], purpose: GitReviewBodyPurpose): void {
		if (this.bodyCache.size === 0) return;
		const next = { ...this.fileBodies };
		for (const filePath of filePaths) {
			const file = this.summaryForFile(filePath);
			if (!file || this.fileBodies[filePath]) continue;
			const key = this.cacheKey(file);
			const cached = this.bodyCache.get(key);
			if (cached) {
				this.bodyCache.delete(key);
				this.bodyCache.set(key, cached);
				const decision = decideGitReviewBodyBudget(
					cached,
					purpose,
					next,
					this.bodyPurposes,
					this.snapshot!.limits,
				);
				this.evictActiveBodies(next, decision);
				if (!decision.accept) {
					if (purpose === 'prefetch') {
						this.stopPrefetch();
					} else {
						next[filePath] = this.collectionLimitBody(cached, decision);
						this.setAggregateLimit(decision, Object.keys(next).length);
					}
					continue;
				}
				next[filePath] = cached;
				this.bodyPurposes.set(filePath, purpose);
			}
		}
		this.fileBodies = next;
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
		return `${this.contextLines}|${file.bodyFingerprint}|${file.path}`;
	}

	private cacheBody(file: GitCommitFileSummary, body: GitReviewFileBody, byteLimit: number): void {
		const key = this.cacheKey(file);
		const existing = this.bodyCache.get(key);
		if (existing) this.bodyCacheBytes -= existing.patchBytes;
		this.bodyCache.delete(key);
		this.bodyCache.set(key, body);
		this.bodyCacheBytes += body.patchBytes;
		while (
			(this.bodyCacheBytes > byteLimit || this.bodyCache.size > MAX_CACHED_FILE_BODIES) &&
			this.bodyCache.size > 0
		) {
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
