import type { GitReviewFileBody } from '$lib/api/git.js';
import {
	normalizeGitReviewDemandFilePaths,
	type GitReviewBodyDemand,
} from './git-review-body-demand.js';
import {
	gitDiffSyntaxCacheKey,
	gitDiffSyntaxSkipReason,
	waitForGitDiffSyntaxWorkSlot,
	type GitDiffFileSyntaxResult,
	type GitDiffSyntaxAttempt,
	type GitDiffSyntaxDocument,
	type GitDiffSyntaxFile,
	type GitDiffSyntaxFileInput,
	type GitDiffSyntaxResults,
} from './git-diff-syntax.js';

interface SyntaxJob {
	generation: number;
	filePath: string;
	cacheKey: string;
}

interface SyntaxCandidate {
	input: GitDiffSyntaxFileInput;
	cacheKey: string;
}

interface SyntaxCacheEntry {
	filePath: string;
	cacheKey: string;
	attempt: Exclude<GitDiffSyntaxAttempt, { status: 'cancelled' }>;
	characterCount: number;
	segmentCount: number;
}

export interface GitDiffSyntaxHighlighterPort {
	highlightGitDiffFile: (
		input: GitDiffSyntaxFileInput,
		signal: AbortSignal,
	) => Promise<GitDiffSyntaxAttempt>;
}

export interface GitDiffSyntaxControllerDependencies {
	waitForWorkSlot: (signal: AbortSignal) => Promise<void>;
	loadHighlighter: () => Promise<GitDiffSyntaxHighlighterPort>;
}

export interface GitDiffSyntaxCacheLimits {
	files: number;
	characters: number;
	segments: number;
}

const DEFAULT_CACHE_LIMITS: GitDiffSyntaxCacheLimits = Object.freeze({
	files: 64,
	characters: 2_000_000,
	segments: 100_000,
});

type GitDiffSyntaxHighlighterModule = typeof import('./git-diff-syntax-highlighter.js');

let highlighterModulePromise: Promise<GitDiffSyntaxHighlighterModule> | null = null;

function loadGitDiffSyntaxHighlighter(): Promise<GitDiffSyntaxHighlighterModule> {
	highlighterModulePromise ??= import('./git-diff-syntax-highlighter.js').catch((error) => {
		highlighterModulePromise = null;
		throw error;
	});
	return highlighterModulePromise;
}

const DEFAULT_DEPENDENCIES = {
	waitForWorkSlot: waitForGitDiffSyntaxWorkSlot,
	loadHighlighter: loadGitDiffSyntaxHighlighter,
} satisfies GitDiffSyntaxControllerDependencies;

export class GitDiffSyntaxController {
	results = $state.raw<GitDiffSyntaxResults>({});

	private currentDocument: GitDiffSyntaxDocument | null = null;
	private filesByPath = new Map<string, GitDiffSyntaxFile>();
	private bodies: Record<string, GitReviewFileBody> = {};
	private viewportPaths = new Set<string>();
	private navigationPaths = new Set<string>();
	private queue: SyntaxJob[] = [];
	private queuedKeys = new Set<string>();
	private activeJob: SyntaxJob | null = null;
	private activeAbort: AbortController | null = null;
	private generation = 0;
	private draining = false;
	private cache = new Map<string, SyntaxCacheEntry>();
	private cachedCharacters = 0;
	private cachedSegments = 0;

	constructor(
		private readonly deps: GitDiffSyntaxControllerDependencies = DEFAULT_DEPENDENCIES,
		private readonly cacheLimits: GitDiffSyntaxCacheLimits = DEFAULT_CACHE_LIMITS,
	) {}

	open(currentDocument: GitDiffSyntaxDocument, bodies: Record<string, GitReviewFileBody>): void {
		this.cancelQueuedWork();
		this.generation += 1;
		this.currentDocument = currentDocument;
		this.filesByPath = new Map(currentDocument.files.map((file) => [file.path, file]));
		this.viewportPaths = new Set();
		this.navigationPaths = new Set();
		this.results = {};
		this.replaceBodies(bodies);
	}

	handleDemand(demand: GitReviewBodyDemand): void {
		if (demand.documentId !== this.currentDocument?.documentId) return;
		const paths = normalizeGitReviewDemandFilePaths(demand.filePaths);
		if (demand.kind === 'viewport') {
			this.viewportPaths = new Set(paths);
		} else {
			for (const path of paths) this.navigationPaths.add(path);
		}
		this.reconcileDemand();
	}

	replaceBodies(bodies: Record<string, GitReviewFileBody>): void {
		this.bodies = bodies;
		if (this.activeJob && !this.isCurrent(this.activeJob)) this.activeAbort?.abort();
		this.pruneActiveResultsToBodies();
		this.reconcileDemand();
	}

	invalidateFile(filePath: string): void {
		if (this.activeJob?.filePath === filePath) this.activeAbort?.abort();
		this.removeActiveResult(filePath);
		this.removeCachedPath(filePath);
		this.reconcileDemand();
	}

	pruneToFilePaths(filePaths: ReadonlySet<string>): void {
		this.viewportPaths = intersect(this.viewportPaths, filePaths);
		this.navigationPaths = intersect(this.navigationPaths, filePaths);
		this.filesByPath = new Map(
			Array.from(this.filesByPath).filter(([filePath]) => filePaths.has(filePath)),
		);
		if (this.currentDocument) {
			this.currentDocument = {
				...this.currentDocument,
				files: this.currentDocument.files.filter((file) => filePaths.has(file.path)),
			};
		}
		this.pruneActiveResultsToPaths(filePaths);
		this.pruneCacheToPaths(filePaths);
		this.reconcileDemand();
	}

	close(options: { preserveCache?: boolean } = {}): void {
		this.cancelQueuedWork();
		this.generation += 1;
		this.currentDocument = null;
		this.filesByPath.clear();
		this.bodies = {};
		this.viewportPaths.clear();
		this.navigationPaths.clear();
		this.results = {};
		if (!options.preserveCache) this.clearCache();
	}

	reset(): void {
		this.close({ preserveCache: false });
	}

	private reconcileDemand(): void {
		this.queue = [];
		this.queuedKeys.clear();
		for (const filePath of this.navigationPaths) this.enqueue(filePath);
		for (const filePath of this.viewportPaths) this.enqueue(filePath);
		if (this.queue.length > 0) void this.drainQueue();
	}

	private enqueue(filePath: string): void {
		const candidate = this.currentCandidate(filePath);
		if (!candidate) return;
		if (this.activeJob?.cacheKey === candidate.cacheKey) return;
		if (this.queuedKeys.has(candidate.cacheKey)) return;

		const cached = this.cacheGet(candidate.cacheKey);
		if (cached) {
			if (cached.attempt.status === 'highlighted') {
				this.publish(filePath, cached.attempt.result);
			}
			this.navigationPaths.delete(filePath);
			return;
		}

		this.queue.push({
			generation: this.generation,
			filePath,
			cacheKey: candidate.cacheKey,
		});
		this.queuedKeys.add(candidate.cacheKey);
	}

	private isCurrent(job: SyntaxJob): boolean {
		if (job.generation !== this.generation) return false;
		return this.currentCandidate(job.filePath)?.cacheKey === job.cacheKey;
	}

	private currentCandidate(filePath: string): SyntaxCandidate | null {
		const currentDocument = this.currentDocument;
		const file = this.filesByPath.get(filePath);
		const body = this.bodies[filePath];
		if (
			!currentDocument ||
			!file ||
			!body ||
			body.bodyState !== 'loaded' ||
			body.patch === null ||
			body.bodyFingerprint !== file.bodyFingerprint
		) {
			return null;
		}
		return {
			input: { documentId: currentDocument.documentId, file, body },
			cacheKey: gitDiffSyntaxCacheKey(currentDocument.documentId, file, body),
		};
	}

	private async drainQueue(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const job = this.queue.shift()!;
				this.queuedKeys.delete(job.cacheKey);
				if (!this.isCurrent(job) || !this.isDemanded(job.filePath)) continue;

				const abort = new AbortController();
				this.activeJob = job;
				this.activeAbort = abort;
				let attempt: GitDiffSyntaxAttempt;
				try {
					attempt = await this.highlightJob(job, abort.signal);
				} catch {
					attempt = { status: 'plain', reason: 'error' };
				} finally {
					this.activeJob = null;
					this.activeAbort = null;
				}
				if (attempt.status === 'cancelled' || !this.isCurrent(job)) continue;

				const retained = this.cacheAttempt(job, attempt);
				if (retained?.attempt.status === 'highlighted') {
					this.publish(job.filePath, retained.attempt.result);
				}
				this.navigationPaths.delete(job.filePath);
			}
		} finally {
			this.draining = false;
			if (this.queue.length > 0) void this.drainQueue();
		}
	}

	private async highlightJob(job: SyntaxJob, signal: AbortSignal): Promise<GitDiffSyntaxAttempt> {
		const candidate = this.currentCandidate(job.filePath);
		if (!candidate || candidate.cacheKey !== job.cacheKey) return { status: 'cancelled' };
		const skipReason = gitDiffSyntaxSkipReason(candidate.input);
		if (skipReason) return { status: 'plain', reason: skipReason };
		await this.deps.waitForWorkSlot(signal);
		if (signal.aborted || !this.isCurrent(job)) return { status: 'cancelled' };
		const highlighter = await this.deps.loadHighlighter();
		if (signal.aborted || !this.isCurrent(job)) return { status: 'cancelled' };
		return highlighter.highlightGitDiffFile(candidate.input, signal);
	}

	private cacheAttempt(
		job: SyntaxJob,
		attempt: Exclude<GitDiffSyntaxAttempt, { status: 'cancelled' }>,
	): SyntaxCacheEntry | null {
		let normalizedAttempt = attempt;
		if (attempt.status === 'highlighted') {
			const current = this.currentCandidate(job.filePath);
			if (
				attempt.result.cacheKey !== job.cacheKey ||
				attempt.result.filePath !== job.filePath ||
				attempt.result.bodyFingerprint !== current?.input.body.bodyFingerprint
			) {
				normalizedAttempt = { status: 'plain', reason: 'error' };
			}
		}

		this.removeCacheKey(job.cacheKey);
		const entry: SyntaxCacheEntry = {
			filePath: job.filePath,
			cacheKey: job.cacheKey,
			attempt: normalizedAttempt,
			characterCount:
				normalizedAttempt.status === 'highlighted' ? normalizedAttempt.result.characterCount : 0,
			segmentCount:
				normalizedAttempt.status === 'highlighted' ? normalizedAttempt.result.segmentCount : 0,
		};
		this.cache.set(job.cacheKey, entry);
		this.cachedCharacters += entry.characterCount;
		this.cachedSegments += entry.segmentCount;
		this.trimCache();
		return this.cache.get(job.cacheKey) ?? null;
	}

	private cacheGet(cacheKey: string): SyntaxCacheEntry | null {
		const entry = this.cache.get(cacheKey);
		if (!entry) return null;
		this.cache.delete(cacheKey);
		this.cache.set(cacheKey, entry);
		return entry;
	}

	private trimCache(): void {
		while (
			this.cache.size > this.cacheLimits.files ||
			this.cachedCharacters > this.cacheLimits.characters ||
			this.cachedSegments > this.cacheLimits.segments
		) {
			let evictionKey: string | undefined;
			for (const [cacheKey, entry] of this.cache) {
				if (!this.isDemanded(entry.filePath)) {
					evictionKey = cacheKey;
					break;
				}
			}
			evictionKey ??= this.cache.keys().next().value;
			if (evictionKey === undefined) break;
			this.removeCacheKey(evictionKey);
		}
	}

	private removeCacheKey(cacheKey: string): void {
		const entry = this.cache.get(cacheKey);
		if (!entry) return;
		this.cache.delete(cacheKey);
		this.cachedCharacters -= entry.characterCount;
		this.cachedSegments -= entry.segmentCount;
		if (this.results[entry.filePath]?.cacheKey === cacheKey) {
			this.removeActiveResult(entry.filePath);
		}
	}

	private removeCachedPath(filePath: string): void {
		for (const [cacheKey, entry] of Array.from(this.cache)) {
			if (entry.filePath === filePath) this.removeCacheKey(cacheKey);
		}
	}

	private publish(filePath: string, result: GitDiffFileSyntaxResult): void {
		if (!this.cache.has(result.cacheKey)) return;
		this.results = { ...this.results, [filePath]: result };
	}

	private removeActiveResult(filePath: string): void {
		if (!this.results[filePath]) return;
		const next = { ...this.results };
		delete next[filePath];
		this.results = next;
	}

	private pruneActiveResultsToBodies(): void {
		const next = { ...this.results };
		let changed = false;
		for (const [filePath, result] of Object.entries(next)) {
			if (this.currentCandidate(filePath)?.cacheKey === result.cacheKey) continue;
			delete next[filePath];
			changed = true;
		}
		if (changed) this.results = next;
	}

	private pruneActiveResultsToPaths(filePaths: ReadonlySet<string>): void {
		const next = { ...this.results };
		let changed = false;
		for (const filePath of Object.keys(next)) {
			if (filePaths.has(filePath)) continue;
			delete next[filePath];
			changed = true;
		}
		if (changed) this.results = next;
	}

	private pruneCacheToPaths(filePaths: ReadonlySet<string>): void {
		for (const [cacheKey, entry] of Array.from(this.cache)) {
			if (!filePaths.has(entry.filePath)) this.removeCacheKey(cacheKey);
		}
	}

	private clearCache(): void {
		this.cache.clear();
		this.cachedCharacters = 0;
		this.cachedSegments = 0;
	}

	private cancelQueuedWork(): void {
		this.activeAbort?.abort();
		this.queue = [];
		this.queuedKeys.clear();
	}

	private isDemanded(filePath: string): boolean {
		return this.navigationPaths.has(filePath) || this.viewportPaths.has(filePath);
	}
}

function intersect(values: ReadonlySet<string>, allowed: ReadonlySet<string>): Set<string> {
	return new Set(Array.from(values).filter((value) => allowed.has(value)));
}
