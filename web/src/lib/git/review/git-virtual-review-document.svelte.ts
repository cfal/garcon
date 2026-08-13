import {
	getGitReviewFileBodies,
	type GitDiffTab,
	type GitReviewCollectionLimit,
	type GitReviewDocumentSummary,
	type GitReviewDocumentIndexedFileBodiesResponse,
	type GitReviewBodyPurpose,
	type GitReviewFileBody,
	type GitReviewFileSummary,
	type GitReviewLimitReason,
} from '$lib/api/git.js';
import { type SplitDiffRowView, type UnifiedDiffRowView } from '$lib/git/review/git-diff-rows.js';
import * as m from '$lib/paraglide/messages.js';
import type { DiffMode, GitDiffActionTarget } from '$lib/git/workbench/git-workbench-types.js';
import type { CommentComposerState } from '$lib/git/review/git-inline-comment.svelte.js';
import type { GitDiffSyntaxResults } from '$lib/git/review/git-diff-syntax.js';
import type { GitWorkbenchLoadGuard } from '$lib/git/workbench/git-workbench-types.js';
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
import {
	normalizeGitReviewDemandFilePaths,
	type GitReviewBodyDemand,
	type GitReviewDemandOutcome,
} from './git-review-body-demand.js';
import { GitReviewDemandReconciler } from './git-review-demand-reconciler.js';
import { GitDiffSyntaxController } from './git-diff-syntax-controller.svelte.js';
import {
	assertGitReviewLoadingOwnership,
	traceGitReviewDemand,
	type GitReviewDemandDebugSnapshot,
} from './git-review-demand-trace.js';

export type GitVirtualReviewRow =
	| GitVirtualFileHeaderRow
	| GitVirtualFilePlaceholderRow
	| GitVirtualFileLimitRow
	| GitVirtualUnifiedRow
	| GitVirtualSplitRow
	| GitVirtualReviewThreadRow
	| GitVirtualCollectionLimitRow;

interface GitVirtualRowBase {
	id: string;
	filePath: string;
	estimatedHeight: number;
}

export interface GitVirtualFileHeaderRow extends GitVirtualRowBase {
	kind: 'file-header';
	file: GitReviewFileSummary;
	isFocused: boolean;
}

export interface GitVirtualFilePlaceholderRow extends GitVirtualRowBase {
	kind: 'file-placeholder';
	file: GitReviewFileSummary;
	loadState: 'unloaded' | 'loading';
}

export interface GitVirtualFileLimitRow extends GitVirtualRowBase {
	kind: 'file-limit';
	file: GitReviewFileSummary;
	title: string;
	message: string;
	reason: GitReviewLimitReason | 'stale-document';
}

export interface GitVirtualUnifiedRow extends GitVirtualRowBase {
	kind: 'unified-row';
	file: GitReviewFileSummary;
	view: UnifiedDiffRowView;
	actionTarget: GitDiffActionTarget | null;
	selectableLineKeys: () => string[];
}

export interface GitVirtualSplitRow extends GitVirtualRowBase {
	kind: 'split-row';
	file: GitReviewFileSummary;
	view: SplitDiffRowView;
	actionTarget: GitDiffActionTarget | null;
	selectableLineKeys: () => string[];
}

export interface GitVirtualReviewThreadRow extends GitVirtualRowBase {
	kind: 'review-thread';
	threadId: string;
	showUnanchoredLabel: boolean;
}

export interface GitVirtualCollectionLimitRow extends GitVirtualRowBase {
	kind: 'collection-limit';
	title: string;
	message: string;
}

export interface GitVirtualReviewDocumentDeps {
	targetKey: () => string;
	targetProjectPath: () => string | null;
	activeTab: () => GitDiffTab;
	visibleFilePaths: () => string[];
	selectedFile: () => string | null;
	selectedLineKeys: () => Set<string>;
	composerState: () => CommentComposerState;
	surfaceError: (message: string) => void;
	markExternallyStale: (reason?: 'stale' | 'document-expired') => void;
}

export type GitVirtualDocumentSummary = Pick<
	GitReviewDocumentSummary,
	'documentId' | 'project' | 'context' | 'files' | 'limits' | 'collectionLimit'
>;

export type GitVirtualRowInteraction =
	| {
			kind: 'workbench';
			activeTab: GitDiffTab;
			selectedLineKeys: Set<string>;
			composerState: CommentComposerState;
	  }
	| { kind: 'commentable'; composerState: CommentComposerState }
	| { kind: 'read-only' };

export interface BuildVirtualRowsOptions {
	summary: GitVirtualDocumentSummary;
	visibleFilePaths: string[];
	fileBodies: Record<string, GitReviewFileBody>;
	loadingBodies: Set<string>;
	focusedFilePath: string | null;
	diffMode: DiffMode;
	contextLines: number;
	interaction: GitVirtualRowInteraction;
	syntaxResults?: GitDiffSyntaxResults;
	collapsedFilePaths?: ReadonlySet<string>;
	placeholderLimit?: {
		title: string;
		message: string;
		reason: GitReviewLimitReason | 'stale-document';
	};
}

type BodyCacheKey = `${GitDiffTab}|${number}|${string}|${string}`;

const BODY_BATCH_SIZE = 24;
const MAX_CACHED_FILE_BODIES = 128;
export class GitVirtualReviewDocumentController {
	summary = $state<GitReviewDocumentSummary | null>(null);
	fileBodies = $state.raw<Record<string, GitReviewFileBody>>({});
	loadingBodies = $state(new Set<string>());
	scrollRequest = $state<{ filePath: string; token: number } | null>(null);
	diffMode = $state<DiffMode>('unified');
	contextLines = $state(5);
	aggregateLimit = $state<GitReviewCollectionLimit | null>(null);

	private bodyCache = new Map<BodyCacheKey, GitReviewFileBody>();
	private bodyCacheBytes = 0;
	private prefetchStopped = false;
	private bodyScheduler: GitReviewBodyScheduler<GitReviewDocumentIndexedFileBodiesResponse> | null =
		null;
	private readonly demandReconciler: GitReviewDemandReconciler;
	private loadGeneration = 0;
	private scrollToken = 0;

	rowSource = $derived.by<GitVirtualReviewRowSource>(() => {
		if (!this.summary) return emptyGitVirtualReviewRowSource();
		const summary = this.aggregateLimit
			? { ...this.summary, collectionLimit: this.aggregateLimit }
			: this.summary;
		const placeholderLimit = this.aggregateLimit
			? {
					title: m.git_virtual_diff_limit_reached(),
					message: this.aggregateLimit.message,
					reason: this.aggregateLimit.reason,
				}
			: undefined;
		return buildGitVirtualReviewRowSource({
			summary,
			visibleFilePaths: this.deps.visibleFilePaths(),
			fileBodies: this.fileBodies,
			syntaxResults: this.syntax.results,
			loadingBodies: this.loadingBodies,
			focusedFilePath: this.deps.selectedFile(),
			diffMode: this.diffMode,
			contextLines: this.contextLines,
			interaction: {
				kind: 'workbench',
				activeTab: this.deps.activeTab(),
				selectedLineKeys: this.deps.selectedLineKeys(),
				composerState: this.deps.composerState(),
			},
			...(placeholderLimit ? { placeholderLimit } : {}),
		});
	});

	constructor(
		private readonly deps: GitVirtualReviewDocumentDeps,
		private readonly syntax = new GitDiffSyntaxController(),
	) {
		this.demandReconciler = new GitReviewDemandReconciler({
			currentDocumentId: () => this.summary?.documentId ?? null,
			requestViewportPaths: (filePaths) => this.requestDemandPaths(filePaths),
			requestNavigationPaths: (filePaths) => this.requestDemandPaths(filePaths),
			reportOutcome: (demand, outcome) => {
				traceGitReviewDemand({
					stage: 'controller',
					owner: 'workbench',
					documentId: demand.documentId,
					fileCount: demand.filePaths.length,
					outcome,
				});
			},
		});
	}

	get hasLoading(): boolean {
		return this.loadingBodies.size > 0;
	}

	summaryForFile(filePath: string): GitReviewFileSummary | null {
		return this.summary?.files.find((file) => file.path === filePath) ?? null;
	}

	applySummary(summary: GitReviewDocumentSummary | null): void {
		const nextBodies = summary ? this.retainedBodiesForSummary(summary) : {};
		this.clearBodyInFlightLoads();
		this.loadingBodies = new Set();
		this.loadGeneration++;
		this.summary = summary;
		this.aggregateLimit = null;
		this.prefetchStopped = false;
		if (summary) {
			this.fileBodies = nextBodies;
			this.syntax.open({ documentId: summary.documentId, files: summary.files }, nextBodies);
			this.replayViewportSyntaxDemand(summary.documentId);
		} else {
			this.fileBodies = {};
			this.syntax.close({ preserveCache: true });
		}
		this.demandReconciler.markReadinessChanged();
	}

	handleBodyDemand(demand: GitReviewBodyDemand): void {
		this.syntax.handleDemand(demand);
		this.demandReconciler.handle(demand);
	}

	markDemandReadinessChanged(): void {
		this.demandReconciler.markReadinessChanged();
	}

	getDemandDebugSnapshot(): GitReviewDemandDebugSnapshot {
		const demand = this.demandReconciler.snapshot();
		return {
			documentId: this.summary?.documentId ?? null,
			demandedPaths: demand.filePaths,
			loadingPaths: Array.from(this.loadingBodies),
			schedulerPendingByPath: Object.fromEntries(
				Array.from(this.loadingBodies, (filePath) => [
					filePath,
					this.bodyScheduler?.hasPending(filePath) === true,
				]),
			),
			readinessGeneration: demand.readinessGeneration,
		};
	}

	focusFile(projectPath: string, filePath: string): void {
		this.discardErrorBody(filePath);
		this.requestBodies(projectPath, [filePath], 'visible');
		this.requestScrollToFile(filePath);
	}

	requestScrollToFile(filePath: string): void {
		this.scrollToken += 1;
		this.scrollRequest = { filePath, token: this.scrollToken };
	}

	requestInitialBodies(projectPath: string, filePaths: string[]): void {
		const [priority, ...prefetch] = unique(filePaths);
		if (priority) this.requestBodies(projectPath, [priority], 'visible');
		this.requestBodies(projectPath, prefetch, 'prefetch');
	}

	requestBodies(
		projectPath: string,
		filePaths: readonly string[],
		purpose: GitReviewBodyPurpose = 'visible',
	): GitReviewDemandOutcome {
		if (!this.summary) return 'not-ready';
		if (this.aggregateLimit) return 'limited';
		if (purpose === 'prefetch' && this.prefetchStopped) return 'already-satisfied';
		const guard = this.createLoadGuard(projectPath);
		this.ensureBodyScheduler(projectPath, guard);
		if (!this.bodyScheduler) return 'not-ready';
		const uniquePaths = normalizeGitReviewDemandFilePaths(filePaths);
		this.seedCachedBodies(uniquePaths, purpose, guard);
		if (this.aggregateLimit) return 'limited';
		const toFetch = uniquePaths.filter((filePath) => this.shouldLoadBody(filePath, guard));
		const pending = uniquePaths.filter(
			(filePath) =>
				this.loadingBodies.has(filePath) &&
				this.summaryForFile(filePath)?.bodyState === 'unloaded' &&
				!this.fileBodies[filePath],
		);
		const scheduled =
			purpose === 'visible'
				? this.bodyScheduler.requestVisible([...toFetch, ...pending])
				: this.bodyScheduler.requestPrefetch(toFetch);
		return scheduled ? 'scheduled' : 'already-satisfied';
	}

	refreshAllData(): void {
		this.bodyCache.clear();
		this.bodyCacheBytes = 0;
		this.syntax.reset();
		this.applySummary(null);
	}

	clearForDisplayChange(): void {
		this.summary = null;
		this.fileBodies = {};
		this.syntax.close({ preserveCache: true });
		this.aggregateLimit = null;
		this.prefetchStopped = false;
		this.loadingBodies = new Set();
		this.loadGeneration++;
		this.clearBodyInFlightLoads();
	}

	invalidateFile(filePath: string): void {
		for (const key of Array.from(this.bodyCache.keys())) {
			if (key.endsWith(`|${filePath}`)) {
				this.bodyCacheBytes -= this.bodyCache.get(key)?.patchBytes ?? 0;
				this.bodyCache.delete(key);
			}
		}
		this.replaceFileBodies(
			Object.fromEntries(
				Object.entries(this.fileBodies).filter(([candidate]) => candidate !== filePath),
			),
		);
		this.syntax.invalidateFile(filePath);
	}

	pruneToFilePaths(paths: Set<string>): void {
		this.replaceFileBodies(
			Object.fromEntries(
				Object.entries(this.fileBodies).filter(([filePath]) => paths.has(filePath)),
			),
		);
		this.syntax.pruneToFilePaths(paths);
		for (const key of Array.from(this.bodyCache.keys())) {
			const filePath = key.split('|').slice(3).join('|');
			if (!paths.has(filePath)) {
				this.bodyCacheBytes -= this.bodyCache.get(key)?.patchBytes ?? 0;
				this.bodyCache.delete(key);
			}
		}
	}

	reset(): void {
		this.summary = null;
		this.fileBodies = {};
		this.syntax.reset();
		this.loadingBodies = new Set();
		this.scrollRequest = null;
		this.aggregateLimit = null;
		this.prefetchStopped = false;
		this.bodyCache.clear();
		this.bodyCacheBytes = 0;
		this.loadGeneration++;
		this.clearBodyInFlightLoads();
		this.demandReconciler.clear();
	}

	private replaceFileBodies(next: Record<string, GitReviewFileBody>): void {
		this.fileBodies = next;
		this.syntax.replaceBodies(next);
	}

	private replayViewportSyntaxDemand(documentId: string): void {
		const demand = this.demandReconciler.snapshot();
		if (demand.documentId !== documentId) return;
		this.syntax.handleDemand({
			kind: 'viewport',
			documentId,
			filePaths: demand.filePaths,
		});
	}

	private requestDemandPaths(filePaths: readonly string[]): GitReviewDemandOutcome {
		const projectPath = this.deps.targetProjectPath();
		if (!projectPath) return 'not-ready';
		return this.requestBodies(projectPath, filePaths, 'visible');
	}

	private createLoadGuard(projectPath: string): GitWorkbenchLoadGuard {
		return {
			generation: this.loadGeneration,
			targetKey: this.deps.targetKey(),
			projectPath,
			tab: this.deps.activeTab(),
			contextLines: this.contextLines,
		};
	}

	private isCurrentGuard(guard: GitWorkbenchLoadGuard): boolean {
		if (guard.generation !== this.loadGeneration) return false;
		if (guard.targetKey !== this.deps.targetKey()) return false;
		if (guard.tab !== this.deps.activeTab()) return false;
		if (guard.contextLines !== this.contextLines) return false;
		const targetProjectPath = this.deps.targetProjectPath();
		return !targetProjectPath || targetProjectPath === guard.projectPath;
	}

	private retainedBodiesForSummary(
		summary: GitReviewDocumentSummary,
	): Record<string, GitReviewFileBody> {
		const files = new Map(summary.files.map((file) => [file.path, file]));
		return Object.fromEntries(
			Object.entries(this.fileBodies).filter(([filePath, body]) => {
				const file = files.get(filePath);
				return Boolean(
					file && body.bodyState !== 'error' && file.bodyFingerprint === body.bodyFingerprint,
				);
			}),
		);
	}

	private discardErrorBody(filePath: string): void {
		if (this.fileBodies[filePath]?.bodyState !== 'error') return;
		this.replaceFileBodies(
			Object.fromEntries(
				Object.entries(this.fileBodies).filter(([candidate]) => candidate !== filePath),
			),
		);
	}

	private shouldLoadBody(filePath: string, guard: GitWorkbenchLoadGuard): boolean {
		const file = this.summaryForFile(filePath);
		if (!file || file.bodyState !== 'unloaded') return false;
		if (this.fileBodies[filePath]) return false;
		if (this.cacheGet(file, guard)) return false;
		return !this.loadingBodies.has(filePath);
	}

	private seedCachedBodies(
		filePaths: string[],
		purpose: GitReviewBodyPurpose,
		guard: GitWorkbenchLoadGuard,
	): void {
		if (this.bodyCache.size === 0) return;
		const next = { ...this.fileBodies };
		const pinnedPaths = this.pinnedBodyPaths();
		let changed = false;
		for (const filePath of filePaths) {
			const file = this.summaryForFile(filePath);
			if (!file || this.fileBodies[filePath]) continue;
			const cached = this.cacheGet(file, guard);
			if (!cached) continue;
			const decision = decideGitReviewBodyBudget(
				cached,
				purpose,
				next,
				pinnedPaths,
				this.summary!.limits,
			);
			this.evictActiveBodies(next, decision);
			changed ||= decision.evictedPaths.length > 0;
			if (!decision.accept) {
				if (purpose === 'prefetch') {
					this.stopPrefetch();
				} else {
					next[filePath] = this.collectionLimitBody(cached, decision);
					changed = true;
					this.setAggregateLimit(decision, Object.keys(next).length);
				}
				continue;
			}
			next[filePath] = cached;
			changed = true;
		}
		if (changed) this.replaceFileBodies(next);
	}

	private ensureBodyScheduler(projectPath: string, guard: GitWorkbenchLoadGuard): void {
		if (this.bodyScheduler || !this.summary) return;
		const summary = this.summary;
		this.bodyScheduler = new GitReviewBodyScheduler({
			maxBatchFiles: summary.limits.maxBodyBatchFiles || BODY_BATCH_SIZE,
			load: (paths, purpose, signal) =>
				getGitReviewFileBodies(
					projectPath,
					summary.documentId,
					paths,
					guard.tab,
					guard.contextLines,
					{ purpose, signal },
				),
			onResult: (result, paths, purpose) => this.applyBodyResult(result, paths, purpose, guard),
			onError: (error) => {
				if (!this.isCurrentGuard(guard)) return;
				this.deps.surfaceError(
					m.git_virtual_load_diff_failed_with_detail({
						detail: error instanceof Error ? error.message : String(error),
					}),
				);
			},
			onLoadingChange: (paths, loading) => this.markLoading(paths, loading),
			onDispatch: (paths, purpose) => {
				traceGitReviewDemand({
					stage: 'scheduler',
					owner: 'workbench',
					documentId: summary.documentId,
					fileCount: paths.length,
					purpose,
				});
			},
		});
	}

	private applyBodyResult(
		result: GitReviewDocumentIndexedFileBodiesResponse,
		paths: string[],
		purpose: GitReviewBodyPurpose,
		guard: GitWorkbenchLoadGuard,
	): void {
		if (!this.isCurrentGuard(guard)) return;
		if (result.status === 'stale' || result.status === 'document-expired') {
			this.deps.markExternallyStale(result.status);
			return;
		}
		const next = { ...this.fileBodies };
		const pinnedPaths = this.pinnedBodyPaths();
		for (const filePath of paths) {
			const file = this.summaryForFile(filePath);
			const body = result.files[filePath];
			if (!file || !body) continue;
			if (body.bodyFingerprint !== file.bodyFingerprint) {
				this.deps.markExternallyStale();
				continue;
			}
			const serverLimit = collectionLimitDecisionFromGitReviewBody(body, next);
			if (serverLimit) {
				next[filePath] = body;
				this.setAggregateLimit(serverLimit, Object.keys(next).length, body.limitMessage);
				break;
			}
			const effectivePurpose =
				purpose === 'prefetch' &&
				this.demandReconciler.demandsPath(this.summary!.documentId, filePath)
					? 'visible'
					: purpose;
			const decision = decideGitReviewBodyBudget(
				body,
				effectivePurpose,
				next,
				pinnedPaths,
				this.summary!.limits,
			);
			this.evictActiveBodies(next, decision);
			if (!decision.accept) {
				if (effectivePurpose === 'prefetch') {
					this.stopPrefetch();
					continue;
				}
				next[filePath] = this.collectionLimitBody(body, decision);
				this.setAggregateLimit(decision, Object.keys(next).length);
				break;
			}
			if (body.bodyState !== 'error') this.cacheSet(file, guard, body);
			next[filePath] = body;
		}
		this.replaceFileBodies(next);
	}

	private collectionLimitBody(
		body: GitReviewFileBody,
		decision: GitReviewBodyBudgetDecision,
	): GitReviewFileBody {
		const reason = decision.reason ?? 'collection-too-many-rows';
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
			limitMessage: this.aggregateLimitMessage(decision),
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
			totalFilesKnown: this.summary?.files.length ?? 0,
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
		}
	}

	private pinnedBodyPaths(): Set<string> {
		const pinned = new Set<string>();
		const documentId = this.summary?.documentId;
		const demand = this.demandReconciler.snapshot();
		if (documentId && demand.documentId === documentId) {
			for (const filePath of demand.filePaths) pinned.add(filePath);
		}
		return pinned;
	}

	private stopPrefetch(): void {
		this.prefetchStopped = true;
		this.bodyScheduler?.cancelPrefetch();
	}

	private markLoading(filePaths: string[], isLoading: boolean): void {
		const next = new Set(this.loadingBodies);
		for (const filePath of filePaths) {
			if (isLoading) next.add(filePath);
			else next.delete(filePath);
		}
		this.loadingBodies = next;
		assertGitReviewLoadingOwnership(
			next,
			(filePath) => this.bodyScheduler?.hasPending(filePath) === true,
			'workbench',
		);
	}

	private cacheKey(file: GitReviewFileSummary, guard: GitWorkbenchLoadGuard): BodyCacheKey {
		return `${guard.tab}|${guard.contextLines}|${file.bodyFingerprint}|${file.path}`;
	}

	private cacheGet(
		file: GitReviewFileSummary,
		guard: GitWorkbenchLoadGuard,
	): GitReviewFileBody | null {
		const key = this.cacheKey(file, guard);
		const body = this.bodyCache.get(key);
		if (!body) return null;
		this.bodyCache.delete(key);
		this.bodyCache.set(key, body);
		return body;
	}

	private cacheSet(
		file: GitReviewFileSummary,
		guard: GitWorkbenchLoadGuard,
		body: GitReviewFileBody,
	): void {
		const key = this.cacheKey(file, guard);
		const previous = this.bodyCache.get(key);
		if (previous) this.bodyCacheBytes -= previous.patchBytes;
		this.bodyCache.delete(key);
		this.bodyCache.set(key, body);
		this.bodyCacheBytes += body.patchBytes;
		const byteLimit = this.summary?.limits.maxLoadedPatchBytes ?? 10_000_000;
		while (
			(this.bodyCache.size > MAX_CACHED_FILE_BODIES || this.bodyCacheBytes > byteLimit) &&
			this.bodyCache.size > 0
		) {
			const oldestKey = this.bodyCache.keys().next().value;
			if (oldestKey === undefined) break;
			this.bodyCacheBytes -= this.bodyCache.get(oldestKey)?.patchBytes ?? 0;
			this.bodyCache.delete(oldestKey);
		}
	}

	private clearBodyInFlightLoads(): void {
		this.bodyScheduler?.cancel();
		this.bodyScheduler = null;
	}
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values));
}
