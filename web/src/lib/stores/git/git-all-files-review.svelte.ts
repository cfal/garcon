import {
	getGitFileReviewFullBatch,
	getGitFileReviewPreviewBatch,
	type GitDiffTab,
	type GitFileReviewCategory,
	type GitFileReviewData,
	type GitReviewDataProfile,
	type GitTreeNode,
} from '$lib/api/git.js';
import type { GitWorkbenchLoadGuard } from './git-workbench-types';

export type GitAllFilesCardState =
	| 'collapsed'
	| 'unloaded'
	| 'loading'
	| 'preview'
	| 'full'
	| 'binary'
	| 'truncated'
	| 'error';

export interface GitAllFilesCard {
	filePath: string;
	category: GitFileReviewCategory;
	state: GitAllFilesCardState;
	reviewData: GitFileReviewData | null;
	rowCount: number;
	isLoadingFull: boolean;
	truncatedReason?: string;
	error?: string;
}

export interface GitAllFilesReviewControllerDeps {
	targetKey: () => string;
	targetProjectPath: () => string | null;
	activeTab: () => GitDiffTab;
	contextLines: () => number;
	visibleFilePaths: () => string[];
	findTreeNode: (filePath: string) => GitTreeNode | undefined;
	surfaceError: (message: string) => void;
}

type ReviewDataKey = `${GitReviewDataProfile}|${GitDiffTab}|${number}|${string}`;

const PREVIEW_BATCH_SIZE = 8;

export class GitAllFilesReviewController {
	diffScrollRequest = $state<{ filePath: string; token: number } | null>(null);
	reviewDataByPath = $state<Record<string, GitFileReviewData>>({});
	private loadingPaths = $state(new Set<string>());
	private fullLoadingPaths = $state(new Set<string>());
	private collapsedPaths = $state(new Set<string>());

	private reviewCache = new Map<ReviewDataKey, GitFileReviewData>();
	private pendingPreviewQueue: string[] = [];
	private previewBatchController: AbortController | null = null;
	private previewBatchFiles = new Set<string>();
	private fullControllers = new Map<string, AbortController>();
	private loadGeneration = 0;
	private diffScrollToken = 0;

	cards = $derived.by<GitAllFilesCard[]>(() =>
		this.deps.visibleFilePaths().map((filePath) => this.buildCard(filePath)),
	);

	constructor(private readonly deps: GitAllFilesReviewControllerDeps) {}

	get hasLoading(): boolean {
		return this.loadingPaths.size > 0 || this.fullLoadingPaths.size > 0;
	}

	requestVisibleFiles(projectPath: string, filePaths: string[]): void {
		const guard = this.createLoadGuard(projectPath);
		const uniquePaths = Array.from(new Set(filePaths)).filter((filePath) =>
			this.shouldLoadProfile(filePath, 'all-files-preview', guard),
		);
		if (uniquePaths.length === 0) return;

		this.seedCachedData(uniquePaths, 'all-files-preview', guard);
		const toFetch = uniquePaths.filter((filePath) =>
			this.shouldLoadProfile(filePath, 'all-files-preview', guard),
		);
		if (toFetch.length === 0) return;

		this.markLoading(toFetch, 'all-files-preview', true);
		this.prioritizePreviewQueue(toFetch);
		this.abortOffscreenPreviewBatch(uniquePaths);
		this.pumpPreviewQueue(projectPath, guard.generation);
	}

	ensureFileLoaded(projectPath: string, filePath: string): void {
		this.requestVisibleFiles(projectPath, [filePath]);
	}

	loadFullFile(projectPath: string, filePath: string): void {
		const guard = this.createLoadGuard(projectPath);
		this.collapsedPaths = new Set(Array.from(this.collapsedPaths).filter((path) => path !== filePath));
		const cached = this.cacheGet(filePath, 'all-files-full', guard.tab, guard.contextLines);
		if (cached) {
			this.reviewDataByPath = { ...this.reviewDataByPath, [filePath]: cached };
			return;
		}
		if (this.fullControllers.has(filePath)) return;

		const controller = new AbortController();
		this.fullControllers.set(filePath, controller);
		this.markLoading([filePath], 'all-files-full', true);

		void getGitFileReviewFullBatch(projectPath, [filePath], guard.tab, guard.contextLines, {
			signal: controller.signal,
		})
			.then((result) => {
				if (!this.isCurrentGuard(guard)) return;
				const data = result.files[filePath] ??
					createDiffLoadError(filePath, guard.tab, 'all-files-full', result.errors[filePath] ?? 'Failed to load diff');
				this.cacheSet(filePath, 'all-files-full', data, guard.tab, guard.contextLines);
				this.reviewDataByPath = { ...this.reviewDataByPath, [filePath]: data };
			})
			.catch((error) => {
				if (isAbortError(error) || !this.isCurrentGuard(guard)) return;
				const errorData = createDiffLoadError(filePath, guard.tab, 'all-files-full', 'Failed to load diff');
				this.reviewDataByPath = { ...this.reviewDataByPath, [filePath]: errorData };
				this.deps.surfaceError(`Failed to load diff: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				if (this.fullControllers.get(filePath) === controller) this.fullControllers.delete(filePath);
				this.markLoading([filePath], 'all-files-full', false);
			});
	}

	toggleCollapsed(filePath: string): void {
		const next = new Set(this.collapsedPaths);
		if (next.has(filePath)) next.delete(filePath);
		else next.add(filePath);
		this.collapsedPaths = next;
	}

	requestDiffScrollToFile(filePath: string): void {
		if (!filePath) return;
		this.diffScrollToken += 1;
		this.diffScrollRequest = { filePath, token: this.diffScrollToken };
	}

	refreshAllData(): void {
		this.reviewCache.clear();
		this.reviewDataByPath = {};
		this.pendingPreviewQueue = [];
		this.loadingPaths = new Set();
		this.fullLoadingPaths = new Set();
		this.loadGeneration++;
		this.clearInFlightLoads();
	}

	clearForDisplayChange(): void {
		this.reviewDataByPath = {};
		this.pendingPreviewQueue = [];
		this.loadingPaths = new Set();
		this.fullLoadingPaths = new Set();
		this.loadGeneration++;
		this.clearInFlightLoads();
	}

	invalidateFile(filePath: string): void {
		const suffix = `|${filePath}`;
		for (const key of Array.from(this.reviewCache.keys())) {
			if (key.endsWith(suffix)) this.reviewCache.delete(key);
		}
		this.removeFileData(filePath);
	}

	removeFileData(filePath: string): void {
		this.reviewDataByPath = Object.fromEntries(
			Object.entries(this.reviewDataByPath).filter(([candidate]) => candidate !== filePath),
		);
	}

	pruneToFilePaths(paths: Set<string>): void {
		this.reviewDataByPath = Object.fromEntries(
			Object.entries(this.reviewDataByPath).filter(([filePath]) => paths.has(filePath)),
		);
		for (const key of Array.from(this.reviewCache.keys())) {
			const filePath = key.split('|').slice(3).join('|');
			if (!paths.has(filePath)) this.reviewCache.delete(key);
		}
		this.collapsedPaths = new Set(Array.from(this.collapsedPaths).filter((filePath) => paths.has(filePath)));
	}

	reset(): void {
		this.diffScrollRequest = null;
		this.reviewDataByPath = {};
		this.pendingPreviewQueue = [];
		this.loadingPaths = new Set();
		this.fullLoadingPaths = new Set();
		this.collapsedPaths = new Set();
		this.reviewCache.clear();
		this.loadGeneration++;
		this.clearInFlightLoads();
	}

	private buildCard(filePath: string): GitAllFilesCard {
		const reviewData = this.reviewDataByPath[filePath] ?? null;
		const category = reviewData?.category ?? this.deps.findTreeNode(filePath)?.category ?? 'normal';
		const rowCount = reviewData?.rows.length ?? 0;
		const base = {
			filePath,
			category,
			reviewData,
			rowCount,
			isLoadingFull: this.fullLoadingPaths.has(filePath),
			truncatedReason: reviewData?.truncatedReason,
			error: reviewData?.error,
		};

		if (this.collapsedPaths.has(filePath)) return { ...base, state: 'collapsed' };
		if (!reviewData) {
			return { ...base, state: this.loadingPaths.has(filePath) ? 'loading' : 'unloaded' };
		}
		if (reviewData.error) return { ...base, state: 'error' };
		if (reviewData.isBinary) return { ...base, state: 'binary' };
		if (reviewData.truncated) return { ...base, state: 'truncated' };
		return { ...base, state: reviewData.profile === 'all-files-full' ? 'full' : 'preview' };
	}

	private createLoadGuard(projectPath: string): GitWorkbenchLoadGuard {
		return {
			generation: this.loadGeneration,
			targetKey: this.deps.targetKey(),
			projectPath,
			tab: this.deps.activeTab(),
			contextLines: this.deps.contextLines(),
		};
	}

	private isCurrentGuard(guard: GitWorkbenchLoadGuard): boolean {
		if (guard.generation !== this.loadGeneration) return false;
		if (guard.targetKey !== this.deps.targetKey()) return false;
		if (guard.tab !== this.deps.activeTab()) return false;
		if (guard.contextLines !== this.deps.contextLines()) return false;
		const targetProjectPath = this.deps.targetProjectPath();
		return !targetProjectPath || targetProjectPath === guard.projectPath;
	}

	private shouldLoadProfile(
		filePath: string,
		profile: GitReviewDataProfile,
		guard: GitWorkbenchLoadGuard,
	): boolean {
		const existing = this.reviewDataByPath[filePath];
		if (existing && existing.profile === 'all-files-full') return false;
		if (existing && profile === 'all-files-preview') return false;
		if (this.cacheGet(filePath, profile, guard.tab, guard.contextLines)) return false;
		if (profile === 'all-files-full' && this.fullControllers.has(filePath)) return false;
		if (profile === 'all-files-preview' && this.pendingPreviewQueue.includes(filePath)) return false;
		if (profile === 'all-files-preview' && this.previewBatchFiles.has(filePath)) return false;
		return true;
	}

	private seedCachedData(
		filePaths: string[],
		profile: GitReviewDataProfile,
		guard: GitWorkbenchLoadGuard,
	): void {
		const seeded: Record<string, GitFileReviewData> = {};
		for (const filePath of filePaths) {
			const cached = this.cacheGet(filePath, 'all-files-full', guard.tab, guard.contextLines) ??
				this.cacheGet(filePath, profile, guard.tab, guard.contextLines);
			if (cached && !this.reviewDataByPath[filePath]) seeded[filePath] = cached;
		}
		if (Object.keys(seeded).length > 0) this.reviewDataByPath = { ...this.reviewDataByPath, ...seeded };
	}

	private prioritizePreviewQueue(filePaths: string[]): void {
		const requested = new Set(filePaths);
		const stalePending = this.pendingPreviewQueue.filter((filePath) => !requested.has(filePath));
		this.pendingPreviewQueue = [...filePaths, ...stalePending];
	}

	private abortOffscreenPreviewBatch(visiblePaths: string[]): void {
		if (!this.previewBatchController) return;
		const visible = new Set(visiblePaths);
		const hasVisibleInFlight = Array.from(this.previewBatchFiles).some((filePath) => visible.has(filePath));
		if (!hasVisibleInFlight) this.previewBatchController.abort();
	}

	private pumpPreviewQueue(projectPath: string, generation: number): void {
		if (this.previewBatchController || this.pendingPreviewQueue.length === 0) return;

		const guard = this.createLoadGuard(projectPath);
		if (guard.generation !== generation) return;
		const batch = this.pendingPreviewQueue.splice(0, PREVIEW_BATCH_SIZE).filter((filePath) =>
			this.shouldStartPreviewLoad(filePath, guard),
		);
		if (batch.length === 0) {
			this.pumpPreviewQueue(projectPath, generation);
			return;
		}

		const controller = new AbortController();
		this.previewBatchController = controller;
		this.previewBatchFiles = new Set(batch);

		void getGitFileReviewPreviewBatch(projectPath, batch, guard.tab, guard.contextLines, {
			signal: controller.signal,
		})
			.then((result) => {
				if (!this.isCurrentGuard(guard)) return;
				const next = { ...this.reviewDataByPath };
				for (const filePath of batch) {
					const data = result.files[filePath] ??
						createDiffLoadError(filePath, guard.tab, 'all-files-preview', result.errors[filePath] ?? 'Failed to load diff');
					this.cacheSet(filePath, 'all-files-preview', data, guard.tab, guard.contextLines);
					next[filePath] = data;
				}
				this.reviewDataByPath = next;
			})
			.catch((error) => {
				if (isAbortError(error)) return;
				if (!this.isCurrentGuard(guard)) return;
				const next = { ...this.reviewDataByPath };
				for (const filePath of batch) {
					const errorData = createDiffLoadError(filePath, guard.tab, 'all-files-preview', 'Failed to load diff');
					this.cacheSet(filePath, 'all-files-preview', errorData, guard.tab, guard.contextLines);
					next[filePath] = errorData;
				}
				this.reviewDataByPath = next;
				this.deps.surfaceError(`Failed to load diff: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				if (this.previewBatchController === controller) this.previewBatchController = null;
				this.previewBatchFiles = new Set();
				this.markLoading(batch, 'all-files-preview', false);
				if (generation === this.loadGeneration) this.pumpPreviewQueue(projectPath, generation);
			});
	}

	private markLoading(filePaths: string[], profile: GitReviewDataProfile, isLoading: boolean): void {
		const current = profile === 'all-files-preview' ? this.loadingPaths : this.fullLoadingPaths;
		const next = new Set(current);
		for (const filePath of filePaths) {
			if (isLoading) next.add(filePath);
			else next.delete(filePath);
		}
		if (profile === 'all-files-preview') this.loadingPaths = next;
		else this.fullLoadingPaths = next;
	}

	private shouldStartPreviewLoad(filePath: string, guard: GitWorkbenchLoadGuard): boolean {
		const existing = this.reviewDataByPath[filePath];
		if (existing) return false;
		if (this.cacheGet(filePath, 'all-files-full', guard.tab, guard.contextLines)) return false;
		if (this.cacheGet(filePath, 'all-files-preview', guard.tab, guard.contextLines)) return false;
		if (this.previewBatchFiles.has(filePath)) return false;
		return true;
	}

	private cacheKey(
		filePath: string,
		profile: GitReviewDataProfile,
		tab = this.deps.activeTab(),
		contextLines = this.deps.contextLines(),
	): ReviewDataKey {
		return `${profile}|${tab}|${contextLines}|${filePath}`;
	}

	private cacheGet(
		filePath: string,
		profile: GitReviewDataProfile,
		tab = this.deps.activeTab(),
		contextLines = this.deps.contextLines(),
	): GitFileReviewData | null {
		return this.reviewCache.get(this.cacheKey(filePath, profile, tab, contextLines)) ?? null;
	}

	private cacheSet(
		filePath: string,
		profile: GitReviewDataProfile,
		data: GitFileReviewData,
		tab = this.deps.activeTab(),
		contextLines = this.deps.contextLines(),
	): void {
		this.reviewCache.set(this.cacheKey(filePath, profile, tab, contextLines), data);
	}

	private clearInFlightLoads(): void {
		this.previewBatchController?.abort();
		this.previewBatchController = null;
		this.previewBatchFiles = new Set();
		for (const controller of this.fullControllers.values()) controller.abort();
		this.fullControllers.clear();
	}
}

function createDiffLoadError(
	filePath: string,
	tab: GitDiffTab,
	profile: GitReviewDataProfile,
	error: string,
): GitFileReviewData {
	return {
		path: filePath,
		mode: tab === 'staged' ? 'staged' : 'working',
		profile,
		isBinary: false,
		truncated: false,
		rows: [],
		hunks: [],
		error,
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}
