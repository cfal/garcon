import * as m from '$lib/paraglide/messages.js';
import { getLocale } from '$lib/paraglide/runtime.js';
import type {
	GitReviewBodyPurpose,
	GitReviewBodyState,
	GitReviewCollectionLimit,
	GitReviewDocumentIndexedFileBodiesResponse,
	GitReviewDocumentLimits,
	GitReviewFileBody,
} from '$lib/api/git.js';
import {
	decideGitReviewBodyBudget,
	gitReviewBodyBytes,
	type GitReviewBodyBudgetDecision,
} from './git-review-body-budget.js';
import {
	normalizeGitReviewDemandFilePaths,
	type GitReviewBodyDemand,
	type GitReviewDemandOutcome,
} from './git-review-body-demand.js';
import { GitReviewBodyScheduler } from './git-review-body-scheduler.js';
import { GitReviewDemandReconciler } from './git-review-demand-reconciler.js';
import {
	assertGitReviewLoadingOwnership,
	traceGitReviewDemand,
} from './git-review-demand-trace.js';
import type { GitDiffSyntaxController } from './git-diff-syntax-controller.svelte.js';
import type { GitDiffSyntaxFile } from './git-diff-syntax.js';

type BodyFile = GitDiffSyntaxFile & { bodyState: GitReviewBodyState };
type BodyResponse = GitReviewDocumentIndexedFileBodiesResponse;
type BodyPurpose = GitReviewBodyPurpose | 'navigation';

interface BodyDocument {
	documentId: string;
	files: BodyFile[];
	limits: GitReviewDocumentLimits;
}

export interface GitReviewBodyLoader {
	cacheScope: () => string;
	isCurrent: () => boolean;
	load: (
		paths: string[],
		purpose: GitReviewBodyPurpose,
		signal: AbortSignal,
		publish: (result: BodyResponse, paths: string[]) => void,
	) => Promise<BodyResponse>;
	onError: (error: unknown) => void;
	onStale: (result: Exclude<BodyResponse, { status: 'ready' }>) => void;
	onReady?: () => void;
	acceptBody: (
		file: BodyFile,
		body: GitReviewFileBody,
		previous: GitReviewFileBody | undefined,
	) => GitReviewFileBody | null;
	shouldCache: (body: GitReviewFileBody) => boolean;
}

export class GitReviewBodyStore {
	fileBodies = $state.raw<Record<string, GitReviewFileBody>>({});
	loadingBodies = $state.raw(new Set<string>());
	aggregateLimit = $state.raw<GitReviewCollectionLimit | null>(null);

	private document: BodyDocument | null = null;
	private files = new Map<string, BodyFile>();
	private loader: GitReviewBodyLoader | null = null;
	private scheduler: GitReviewBodyScheduler<BodyResponse> | null = null;
	private readonly reconciler: GitReviewDemandReconciler;
	private cache = new Map<string, GitReviewFileBody>();
	private cacheBytes = 0;
	private prefetchStopped = false;
	private suspended = false;

	constructor(
		readonly syntax: GitDiffSyntaxController,
		private readonly owner: 'workbench' | 'document',
		request: (
			paths: readonly string[],
			purpose: 'visible' | 'navigation',
		) => GitReviewDemandOutcome,
	) {
		this.reconciler = new GitReviewDemandReconciler({
			currentDocumentId: () => this.document?.documentId ?? null,
			requestViewportPaths: (paths) => {
				this.scheduler?.retainVisible(new Set(paths));
				if (paths.length === 0) this.scheduler?.cancelPrefetch();
				return request(paths, 'visible');
			},
			requestNavigationPaths: (paths) => request(paths, 'navigation'),
			reportOutcome: (demand, outcome) => {
				traceGitReviewDemand({
					stage: 'controller',
					owner,
					documentId: demand.documentId,
					fileCount: demand.filePaths.length,
					outcome,
				});
			},
		});
	}

	open(document: BodyDocument, bodies: Record<string, GitReviewFileBody> = {}): void {
		this.suspend();
		this.suspended = false;
		this.document = document;
		this.files = new Map(document.files.map((file) => [file.path, file]));
		this.fileBodies = bodies;
		this.aggregateLimit = null;
		this.prefetchStopped = false;
		this.syntax.open({ documentId: document.documentId, files: document.files }, bodies);
		const demand = this.reconciler.snapshot();
		if (demand.documentId === document.documentId) {
			this.syntax.handleDemand({
				kind: 'viewport',
				documentId: demand.documentId,
				filePaths: demand.filePaths,
			});
		}
	}

	suspend(): void {
		this.suspended = true;
		this.scheduler?.cancel();
		this.scheduler = null;
		this.loader = null;
		if (this.loadingBodies.size > 0) this.loadingBodies = new Set();
	}

	close(options: { preserveCache?: boolean; preserveDemand?: boolean } = {}): void {
		this.suspend();
		this.document = null;
		this.files.clear();
		this.fileBodies = {};
		this.aggregateLimit = null;
		this.syntax.close(options);
		if (!options.preserveCache) this.clearCache();
		if (!options.preserveDemand) this.reconciler.clear();
	}

	configure(createLoader: () => GitReviewBodyLoader): void {
		const document = this.document;
		if (!document || this.suspended || this.scheduler) return;
		const loader = createLoader();
		this.loader = loader;
		this.scheduler = new GitReviewBodyScheduler({
			maxBatchFiles: 4,
			deferredPaths: (result) => (result.status === 'ready' ? result.deferredFiles : []),
			load: loader.load,
			onResult: (result, paths, purpose) =>
				this.applyResult(document, loader, result, paths, purpose),
			onError: (error) => {
				if (this.loader === loader && loader.isCurrent()) loader.onError(error);
			},
			onLoadingChange: (paths, loading) => this.markLoading(paths, loading),
			onDispatch: (paths, purpose) => {
				traceGitReviewDemand({
					stage: 'scheduler',
					owner: this.owner,
					documentId: document.documentId,
					fileCount: paths.length,
					purpose,
				});
			},
		});
	}

	handleDemand(demand: GitReviewBodyDemand): void {
		this.syntax.handleDemand(demand);
		this.reconciler.handle(demand);
	}

	markReadinessChanged(): void {
		this.reconciler.markReadinessChanged();
	}

	getDemandDebugSnapshot() {
		const demand = this.reconciler.snapshot();
		return {
			documentId: this.document?.documentId ?? null,
			demandedPaths: demand.filePaths,
			loadingPaths: Array.from(this.loadingBodies),
			schedulerPendingByPath: Object.fromEntries(
				Array.from(this.loadingBodies, (path) => [path, this.scheduler?.hasPending(path) === true]),
			),
			readinessGeneration: demand.readinessGeneration,
		};
	}

	requestInitial(
		paths: readonly string[],
		request: (paths: readonly string[], purpose: BodyPurpose) => void,
	): void {
		const [priority, ...prefetch] = normalizeGitReviewDemandFilePaths(paths);
		if (priority) request([priority], 'navigation');
		request(prefetch.slice(0, 2), 'prefetch');
	}

	request(paths: readonly string[], purpose: BodyPurpose): GitReviewDemandOutcome {
		const { document, scheduler, loader } = this;
		if (!document || !scheduler || !loader || !loader.isCurrent()) return 'not-ready';
		if (purpose === 'navigation') {
			this.syntax.handleDemand({
				kind: 'navigation',
				documentId: document.documentId,
				filePaths: paths,
			});
		}
		if (this.aggregateLimit) return 'limited';
		if (purpose === 'prefetch' && this.prefetchStopped) return 'already-satisfied';
		const unique = normalizeGitReviewDemandFilePaths(paths);
		this.seedCache(document, loader, unique, purpose === 'navigation' ? 'visible' : purpose);
		if (this.aggregateLimit) return 'limited';
		if (purpose === 'prefetch' && this.prefetchStopped) return 'already-satisfied';
		const candidates = unique.filter(
			(path) => this.files.get(path)?.bodyState === 'unloaded' && !this.fileBodies[path],
		);
		const fresh = candidates.filter((path) => !this.loadingBodies.has(path));
		const visible =
			purpose === 'prefetch'
				? []
				: [...fresh, ...candidates.filter((path) => this.loadingBodies.has(path))];
		const scheduled =
			purpose === 'navigation'
				? scheduler.requestNavigation(visible)
				: purpose === 'visible'
					? scheduler.requestVisible(visible)
					: scheduler.requestPrefetch(fresh);
		return scheduled ? 'scheduled' : 'already-satisfied';
	}

	discardError(path: string): void {
		if (this.fileBodies[path]?.bodyState === 'error') this.removeBody(path);
	}

	invalidate(path: string): void {
		for (const [key, body] of this.cache) if (body.path === path) this.dropCachedBody(key);
		this.removeBody(path);
		this.syntax.invalidateFile(path);
	}

	prune(paths: ReadonlySet<string>): void {
		const entries = Object.entries(this.fileBodies);
		const retained = entries.filter(([path]) => paths.has(path));
		if (retained.length !== entries.length) this.replaceBodies(Object.fromEntries(retained));
		this.syntax.pruneToFilePaths(paths);
		for (const [key, body] of this.cache) if (!paths.has(body.path)) this.dropCachedBody(key);
	}

	private clearCache(): void {
		this.cache.clear();
		this.cacheBytes = 0;
	}

	private removeBody(path: string): void {
		if (!this.fileBodies[path]) return;
		const next = { ...this.fileBodies };
		delete next[path];
		this.replaceBodies(next);
	}

	private replaceBodies(next: Record<string, GitReviewFileBody>): void {
		this.fileBodies = next;
		this.syntax.replaceBodies(next);
	}

	private applyResult(
		document: BodyDocument,
		loader: GitReviewBodyLoader,
		result: BodyResponse,
		paths: string[],
		purpose: GitReviewBodyPurpose,
	): void {
		if (this.loader !== loader || !loader.isCurrent() || result.documentId !== document.documentId)
			return;
		if (result.status !== 'ready') {
			loader.onStale(result);
			return;
		}
		loader.onReady?.();
		if (this.loader !== loader || !loader.isCurrent()) return;
		const previous = this.fileBodies;
		let next: Record<string, GitReviewFileBody> | undefined;
		const pinned = this.pinnedPaths(document.documentId);
		for (const path of paths) {
			const file = this.files.get(path);
			const received = result.files[path];
			if (!file || !received) continue;
			const body = loader.acceptBody(file, received, previous[path]);
			if (this.loader !== loader || !loader.isCurrent()) return;
			if (!body) continue;
			next ??= { ...previous };
			if (body.bodyState === 'error') {
				next[path] = body;
				continue;
			}
			const effectivePurpose = purpose === 'prefetch' && pinned.has(path) ? 'visible' : purpose;
			const accepted = this.admitBody(document, path, body, effectivePurpose, next, pinned);
			if (accepted && loader.shouldCache(body)) {
				this.cacheBody(this.cacheKey(loader, file), body, document.limits.maxLoadedPatchBytes);
			}
			if (this.aggregateLimit) break;
		}
		if (next) this.replaceBodies(next);
	}

	private seedCache(
		document: BodyDocument,
		loader: GitReviewBodyLoader,
		paths: string[],
		purpose: GitReviewBodyPurpose,
	): void {
		if (this.cache.size === 0) return;
		let next: Record<string, GitReviewFileBody> | undefined;
		const pinned = this.pinnedPaths(document.documentId);
		for (const path of paths) {
			const file = this.files.get(path);
			if (!file || (next ?? this.fileBodies)[path]) continue;
			const key = this.cacheKey(loader, file);
			const body = this.cache.get(key);
			if (!body) continue;
			this.cache.delete(key);
			this.cache.set(key, body);
			this.admitBody(document, path, body, purpose, (next ??= { ...this.fileBodies }), pinned);
			if (this.aggregateLimit) break;
		}
		if (next) this.replaceBodies(next);
	}

	private admitBody(
		document: BodyDocument,
		filePath: string,
		body: GitReviewFileBody,
		purpose: GitReviewBodyPurpose,
		next: Record<string, GitReviewFileBody>,
		pinned: Set<string>,
	): boolean {
		const decision = decideGitReviewBodyBudget(body, purpose, next, pinned, document.limits);
		for (const path of decision.evictedPaths) delete next[path];
		if (decision.accept) {
			next[filePath] = body;
			return true;
		}
		if (purpose === 'prefetch') {
			this.prefetchStopped = true;
			this.scheduler?.cancelPrefetch();
		} else {
			this.limitCollection(document, filePath, body, next, decision);
		}
		return false;
	}

	private limitCollection(
		document: BodyDocument,
		filePath: string,
		body: GitReviewFileBody,
		next: Record<string, GitReviewFileBody>,
		decision: GitReviewBodyBudgetDecision,
	): void {
		const reason = decision.reason ?? 'collection-too-many-rows';
		const message =
			reason === 'collection-too-many-bytes'
				? m.git_review_collection_patch_bytes_limit()
				: m.git_review_collection_rows_limit({ count: decision.loadedRows.toLocaleString(getLocale()) });
		next[filePath] = {
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
		this.scheduler?.cancel();
		this.aggregateLimit = {
			reason,
			message,
			visibleFiles: Object.keys(next).length,
			totalFilesKnown: document.files.length,
		};
	}

	private pinnedPaths(documentId: string): Set<string> {
		const demand = this.reconciler.snapshot();
		return new Set(demand.documentId === documentId ? demand.filePaths : []);
	}

	private markLoading(paths: string[], loading: boolean): void {
		const next = new Set(this.loadingBodies);
		for (const path of paths) {
			if (loading) next.add(path);
			else next.delete(path);
		}
		this.loadingBodies = next;
		assertGitReviewLoadingOwnership(
			next,
			(path) => this.scheduler?.hasPending(path) === true,
			this.owner,
		);
	}

	private cacheKey(loader: GitReviewBodyLoader, file: BodyFile): string {
		return JSON.stringify([loader.cacheScope(), file.bodyFingerprint, file.path]);
	}

	private cacheBody(key: string, body: GitReviewFileBody, byteLimit: number): void {
		this.dropCachedBody(key);
		const bytes = gitReviewBodyBytes(body);
		if (bytes > byteLimit) return;
		this.cache.set(key, body);
		this.cacheBytes += bytes;
		while (this.cacheBytes > byteLimit || this.cache.size > 128) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.dropCachedBody(oldest);
		}
	}

	private dropCachedBody(key: string): void {
		this.cacheBytes -= gitReviewBodyBytes(this.cache.get(key));
		this.cache.delete(key);
	}
}
