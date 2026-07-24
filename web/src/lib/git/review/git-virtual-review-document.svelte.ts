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
import {
	type SplitDiffRowView,
	type UnifiedDiffRowView,
} from '$lib/git/review/git-diff-rows.js';
import * as m from '$lib/paraglide/messages.js';
import type { DiffMode, GitDiffActionTarget } from '$lib/git/workbench/git-workbench-types.js';
import type { CommentComposerState } from '$lib/git/review/git-inline-comment.svelte.js';
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
	private bodyPurposes = new Map<string, GitReviewBodyPurpose>();
	private bodyCacheBytes = 0;
	private prefetchStopped = false;
	private bodyScheduler: GitReviewBodyScheduler<GitReviewDocumentIndexedFileBodiesResponse> | null =
		null;
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

	constructor(private readonly deps: GitVirtualReviewDocumentDeps) {}

	get hasLoading(): boolean {
		return this.loadingBodies.size > 0;
	}

	summaryForFile(filePath: string): GitReviewFileSummary | null {
		return this.summary?.files.find((file) => file.path === filePath) ?? null;
	}

	applySummary(summary: GitReviewDocumentSummary | null): void {
		this.clearBodyInFlightLoads();
		this.loadingBodies = new Set();
		this.loadGeneration++;
		this.summary = summary;
		this.aggregateLimit = null;
		this.prefetchStopped = false;
		if (summary) {
			this.pruneBodiesToSummary(summary);
		} else {
			this.fileBodies = {};
			this.bodyPurposes.clear();
		}
	}

	setVisibleRows(projectPath: string, rows: GitVirtualReviewRow[]): void {
		if (!this.summary) return;
		const filePaths = Array.from(new Set(rows.map((row) => row.filePath).filter(Boolean)));
		this.requestBodies(projectPath, filePaths, 'visible');
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
		filePaths: string[],
		purpose: GitReviewBodyPurpose = 'visible',
	): void {
		if (!this.summary || this.aggregateLimit) return;
		if (purpose === 'prefetch' && this.prefetchStopped) return;
		const guard = this.createLoadGuard(projectPath);
		this.ensureBodyScheduler(projectPath, guard);
		const uniquePaths = unique(filePaths).filter(Boolean);
		this.seedCachedBodies(uniquePaths, purpose, guard);
		const toFetch = uniquePaths.filter((filePath) => this.shouldLoadBody(filePath, guard));
		if (toFetch.length === 0) return;

		if (purpose === 'visible') this.bodyScheduler?.requestVisible(toFetch);
		else this.bodyScheduler?.requestPrefetch(toFetch);
	}

	refreshAllData(): void {
		this.bodyCache.clear();
		this.bodyCacheBytes = 0;
		this.applySummary(null);
	}

	clearForDisplayChange(): void {
		this.summary = null;
		this.fileBodies = {};
		this.bodyPurposes.clear();
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
		this.fileBodies = Object.fromEntries(
			Object.entries(this.fileBodies).filter(([candidate]) => candidate !== filePath),
		);
		this.bodyPurposes.delete(filePath);
	}

	pruneToFilePaths(paths: Set<string>): void {
		this.fileBodies = Object.fromEntries(
			Object.entries(this.fileBodies).filter(([filePath]) => paths.has(filePath)),
		);
		for (const filePath of this.bodyPurposes.keys()) {
			if (!paths.has(filePath)) this.bodyPurposes.delete(filePath);
		}
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
		this.bodyPurposes.clear();
		this.loadingBodies = new Set();
		this.scrollRequest = null;
		this.aggregateLimit = null;
		this.prefetchStopped = false;
		this.bodyCache.clear();
		this.bodyCacheBytes = 0;
		this.loadGeneration++;
		this.clearBodyInFlightLoads();
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

	private pruneBodiesToSummary(summary: GitReviewDocumentSummary): void {
		const files = new Map(summary.files.map((file) => [file.path, file]));
		this.fileBodies = Object.fromEntries(
			Object.entries(this.fileBodies).filter(([filePath, body]) => {
				const file = files.get(filePath);
				return Boolean(
					file &&
						body.bodyState !== 'error' &&
						file.bodyFingerprint === body.bodyFingerprint,
				);
			}),
		);
		for (const filePath of this.bodyPurposes.keys()) {
			if (!this.fileBodies[filePath]) this.bodyPurposes.delete(filePath);
		}
	}

	private discardErrorBody(filePath: string): void {
		if (this.fileBodies[filePath]?.bodyState !== 'error') return;
		this.fileBodies = Object.fromEntries(
			Object.entries(this.fileBodies).filter(([candidate]) => candidate !== filePath),
		);
		this.bodyPurposes.delete(filePath);
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
		const next = { ...this.fileBodies };
		for (const filePath of filePaths) {
			const file = this.summaryForFile(filePath);
			if (!file || this.fileBodies[filePath]) continue;
			const cached = this.cacheGet(file, guard);
			if (!cached) continue;
			const decision = decideGitReviewBodyBudget(
				cached,
				purpose,
				next,
				this.bodyPurposes,
				this.summary!.limits,
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
		this.fileBodies = next;
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
			onResult: (result, paths, purpose) =>
				this.applyBodyResult(result, paths, purpose, guard),
			onError: (error) => {
				if (!this.isCurrentGuard(guard)) return;
				this.deps.surfaceError(
					m.git_virtual_load_diff_failed_with_detail({
						detail: error instanceof Error ? error.message : String(error),
					}),
				);
			},
			onLoadingChange: (paths, loading) => this.markLoading(paths, loading),
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
				this.summary!.limits,
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
			if (body.bodyState !== 'error') this.cacheSet(file, guard, body);
			next[filePath] = body;
			this.bodyPurposes.set(filePath, purpose);
		}
		this.fileBodies = next;
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
			this.bodyPurposes.delete(path);
		}
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
