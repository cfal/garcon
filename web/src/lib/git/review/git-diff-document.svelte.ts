import type {
	GitCommitFileSummary,
	GitDiffFileRequest,
	GitReviewCollectionLimit,
	GitReviewDocumentLimits,
	GitReviewDocumentIndexedFileBodiesResponse,
	GitReviewBodyPurpose,
	GitReviewFileSummary,
} from '$lib/api/git.js';
import {
	GitInlineCommentState,
	type CommentComposerState,
	type GitDiffSeverity,
} from '$lib/git/review/git-inline-comment.svelte.js';
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
import { GitReviewBodyStore } from './git-review-body-store.svelte.js';
import {
	buildGitVirtualReviewRowSource,
	emptyGitVirtualReviewRowSource,
	type GitVirtualReviewRowSource,
} from './git-virtual-review-row-source.js';
import type { GitReviewBodyDemand } from './git-review-body-demand.js';
import { GitDiffSyntaxController } from './git-diff-syntax-controller.svelte.js';
import { statusToIndexStatus } from './git-commit-file-status.js';
import * as m from '$lib/paraglide/messages.js';

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
	publish: (result: GitDiffDocumentBodyResponse, paths: string[]) => void,
) => Promise<GitDiffDocumentBodyResponse>;

export interface GitDiffDocumentOpenOptions {
	contextLines: number;
	diffMode: DiffMode;
	loadBodies: GitDiffDocumentBodyLoader;
	onError: (message: string) => void;
	onBodyLoadSuccess?: () => void;
	onStale?: (message: string) => void;
	onExpired?: (message: string) => void;
	// Every review document is commentable; the source describes the comparison
	// for the generated chat comment. Read-only diff rendering belongs to the
	// PR surface's own row source, not to this controller.
	commentSource: GitReviewCommentSource;
}

export class GitDiffDocumentController {
	readonly inlineComment = new GitInlineCommentState();
	snapshot = $state.raw<GitDiffDocumentSnapshot | null>(null);
	scrollRequest = $state<{ filePath: string; token: number } | null>(null);
	fileFilter = $state('');
	focusedFilePath = $state<string | null>(null);
	diffMode = $state<DiffMode>('unified');
	contextLines = $state(5);
	isStale = $state(false);
	staleMessage = $state<string | null>(null);

	readonly bodies: GitReviewBodyStore;
	private summariesByPath = new Map<string, GitCommitFileSummary>();
	private generation = 0;
	private scrollToken = 0;
	private onStale: ((message: string) => void) | null = null;
	private commentSource: GitReviewCommentSource | null = null;

	constructor(syntax = new GitDiffSyntaxController()) {
		this.bodies = new GitReviewBodyStore(syntax, 'document', (paths, purpose) =>
			this.bodies.request(paths, purpose),
		);
	}

	get fileBodies() {
		return this.bodies.fileBodies;
	}

	get loadingBodies() {
		return this.bodies.loadingBodies;
	}

	get aggregateLimit() {
		return this.bodies.aggregateLimit;
	}

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

	private interaction = $derived({
		kind: 'commentable' as const,
		composerState: this.commentComposer,
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
		const syntaxResults = () => this.bodies.syntax.results;
		const loadingBodies = () => this.loadingBodies;
		const focusedFilePath = () => this.focusedFilePath;
		const interaction = () => this.interaction;
		return buildGitVirtualReviewRowSource({
			summary,
			visibleFilePaths: summary.files.map((file) => file.path),
			fileBodies: this.fileBodies,
			get syntaxResults() {
				return syntaxResults();
			},
			get loadingBodies() {
				return loadingBodies();
			},
			get focusedFilePath() {
				return focusedFilePath();
			},
			diffMode: this.diffMode,
			contextLines: this.contextLines,
			get interaction() {
				return interaction();
			},
			...(placeholderLimit ? { placeholderLimit } : {}),
		});
	});

	open(snapshot: GitDiffDocumentSnapshot, options: GitDiffDocumentOpenOptions): void {
		this.generation += 1;
		this.snapshot = snapshot;
		this.summariesByPath = new Map(snapshot.files.map((file) => [file.path, file]));
		this.onStale = options.onStale ?? null;
		this.commentSource = options.commentSource;
		this.diffMode = options.diffMode;
		this.contextLines = options.contextLines;
		this.bodies.open(snapshot);
		this.scrollRequest = null;
		this.fileFilter = '';
		this.focusedFilePath = null;
		this.isStale = false;
		this.staleMessage = null;
		this.closeCommentComposer();
		this.clearCommentFeedback();
		const generation = this.generation;
		this.bodies.configure(() => ({
			cacheScope: () => JSON.stringify([snapshot.documentId, this.contextLines]),
			isCurrent: () => this.isCurrent(generation, snapshot.documentId),
			load: (paths, purpose, signal, publish) => {
				const requests = paths.map((path) => {
					const summary = this.summaryForFile(path);
					return { path, ...(summary?.originalPath ? { originalPath: summary.originalPath } : {}) };
				});
				return options.loadBodies(snapshot, requests, purpose, signal, publish);
			},
			onError: (error) => options.onError(error instanceof Error ? error.message : String(error)),
			onReady: options.onBodyLoadSuccess,
			onStale: (result) => {
				this.markStale(result.message);
				if (result.status === 'document-expired') options.onExpired?.(result.message);
			},
			acceptBody: (file, body) => {
				if (body.bodyState === 'error' || body.bodyFingerprint === file.bodyFingerprint)
					return body;
				return {
					...body,
					bodyState: 'error',
					isBinary: false,
					isTooLarge: false,
					renderedRowCount: 0,
					patchBytes: 0,
					patch: null,
					patchIndex: null,
					error: m.git_diff_document_changed(),
				};
			},
			shouldCache: (body) => body.bodyState === 'loaded',
		}));
		this.bodies.requestInitial(snapshot.firstBodyCandidates, (paths, purpose) =>
			this.bodies.request(paths, purpose),
		);
		this.bodies.markReadinessChanged();
	}

	setDisplayOptions(diffMode: DiffMode, contextLines: number): void {
		this.diffMode = diffMode;
		this.contextLines = contextLines;
	}

	focusFile(filePath: string): void {
		this.focusedFilePath = filePath;
		this.bodies.discardError(filePath);
		this.bodies.request([filePath], 'navigation');
		this.scrollToken += 1;
		this.scrollRequest = { filePath, token: this.scrollToken };
	}

	handleBodyDemand(demand: GitReviewBodyDemand): void {
		this.bodies.handleDemand(demand);
	}

	getDemandDebugSnapshot() {
		return this.bodies.getDemandDebugSnapshot();
	}

	setFileFilter(value: string): void {
		this.fileFilter = value;
	}

	openCommentComposer(filePath: string, side: 'before' | 'after', line: number): void {
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
		this.bodies.suspend();
		this.isStale = true;
		this.staleMessage = message ?? m.git_virtual_stale_diff_message();
		if (message) this.onStale?.(message);
	}

	clear(options: { preserveCache?: boolean } = {}): void {
		this.generation += 1;
		this.snapshot = null;
		this.summariesByPath.clear();
		this.bodies.close(options);
		this.scrollRequest = null;
		this.fileFilter = '';
		this.focusedFilePath = null;
		this.isStale = false;
		this.staleMessage = null;
		this.closeCommentComposer();
		this.clearCommentFeedback();
		this.onStale = null;
		this.commentSource = null;
	}

	private isCurrent(generation: number, documentId: string): boolean {
		return generation === this.generation && this.snapshot?.documentId === documentId;
	}

	private summaryForFile(filePath: string): GitCommitFileSummary | null {
		return this.summariesByPath.get(filePath) ?? null;
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
