import {
	getGitFileReviewData,
	getGitFileReviewDataBatch,
	type GitDiffTab,
	type GitFileReviewData,
} from '$lib/api/git.js';
import type { GitWorkbenchLoadGuard } from './git-workbench-types';

export interface GitReviewDataLoaderDeps {
	targetKey: () => string;
	targetProjectPath: () => string | null;
	activeTab: () => GitDiffTab;
	contextLines: () => number;
	surfaceError: (message: string) => void;
}

type ReviewDataKey = `${GitDiffTab}|${number}|${string}`;

export class GitReviewDataLoader {
	selectedFile = $state<string | null>(null);
	diffScrollRequest = $state<{ filePath: string; token: number } | null>(null);
	reviewDataByPath = $state<Record<string, GitFileReviewData>>({});
	isLoadingFile = $state(false);

	private inFlightByKey = new Map<ReviewDataKey, Promise<GitFileReviewData | null>>();
	private batchResolversByKey = new Map<ReviewDataKey, (data: GitFileReviewData | null) => void>();
	private pendingLoadQueue: string[] = [];
	private loadGeneration = 0;
	private loadProjectPath = '';
	private fileLoadRequestId = 0;
	private diffScrollToken = 0;
	private reviewCache = new Map<string, GitFileReviewData>();

	constructor(private readonly deps: GitReviewDataLoaderDeps) {}

	get currentReviewData(): GitFileReviewData | null {
		if (!this.selectedFile) return null;
		return this.reviewDataByPath[this.selectedFile] ?? null;
	}

	async loadFileReviewData(projectPath: string, filePath: string): Promise<void> {
		const guard = this.createLoadGuard(projectPath);
		const tab = guard.tab;
		const contextLines = guard.contextLines;
		const cached = this.cacheGet(filePath, tab, contextLines);
		if (cached) {
			this.reviewDataByPath = { ...this.reviewDataByPath, [filePath]: cached };
			return;
		}
		const requestId = ++this.fileLoadRequestId;
		this.isLoadingFile = true;
		try {
			const data = await this.loadFileOnce(projectPath, filePath, tab, contextLines);
			if (!this.isCurrentFileLoadGuard(guard)) return;
			if (!data) return;
			this.cacheSet(filePath, data, tab, contextLines);
			this.reviewDataByPath = { ...this.reviewDataByPath, [filePath]: data };
		} catch (error) {
			if (!this.isCurrentFileLoadGuard(guard)) return;
			this.deps.surfaceError(
				`Failed to load diff: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (requestId === this.fileLoadRequestId && this.isCurrentFileLoadGuard(guard)) {
				this.isLoadingFile = false;
			}
		}
	}

	requestFilesLoaded(projectPath: string, filePaths: string[]): void {
		this.loadProjectPath = projectPath;
		const tab = this.deps.activeTab();
		const contextLines = this.deps.contextLines();

		const seeded: Record<string, GitFileReviewData> = {};
		const toFetch: string[] = [];

		for (const filePath of filePaths) {
			const cached = this.cacheGet(filePath, tab, contextLines);
			if (cached) {
				if (!this.reviewDataByPath[filePath]) seeded[filePath] = cached;
				continue;
			}
			if (this.inFlightByKey.has(this.cacheKey(filePath, tab, contextLines))) continue;
			if (toFetch.includes(filePath) || this.pendingLoadQueue.includes(filePath)) continue;
			toFetch.push(filePath);
		}

		if (Object.keys(seeded).length > 0) {
			this.reviewDataByPath = { ...this.reviewDataByPath, ...seeded };
		}

		this.pendingLoadQueue = [...this.pendingLoadQueue, ...toFetch];
		if (toFetch.length > 0) this.pumpFileQueue();
	}

	requestDiffScrollToFile(filePath: string): void {
		if (!filePath) return;
		this.diffScrollToken += 1;
		this.diffScrollRequest = { filePath, token: this.diffScrollToken };
	}

	refreshAllData(): void {
		this.reviewCache.clear();
		this.reviewDataByPath = {};
		this.pendingLoadQueue = [];
		this.isLoadingFile = false;
		this.loadGeneration++;
		this.clearInFlightLoads();
	}

	clearForDisplayChange(): void {
		this.reviewDataByPath = {};
		this.pendingLoadQueue = [];
		this.isLoadingFile = false;
		this.loadGeneration++;
		this.clearInFlightLoads();
	}

	invalidateFile(filePath: string): void {
		const suffix = `|${filePath}`;
		for (const key of this.reviewCache.keys()) {
			if (key.endsWith(suffix)) this.reviewCache.delete(key);
		}
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
			const filePath = key.split('|').slice(2).join('|');
			if (!paths.has(filePath)) this.reviewCache.delete(key);
		}
	}

	reset(): void {
		this.selectedFile = null;
		this.diffScrollRequest = null;
		this.reviewDataByPath = {};
		this.isLoadingFile = false;
		this.pendingLoadQueue = [];
		this.loadGeneration++;
		this.reviewCache.clear();
		this.clearInFlightLoads();
	}

	private createLoadGuard(
		projectPath: string,
		generation = this.loadGeneration,
	): GitWorkbenchLoadGuard {
		return {
			generation,
			targetKey: this.deps.targetKey(),
			projectPath,
			tab: this.deps.activeTab(),
			contextLines: this.deps.contextLines(),
		};
	}

	private isCurrentLoadGuard(guard: GitWorkbenchLoadGuard): boolean {
		if (guard.generation !== this.loadGeneration) return false;
		if (guard.targetKey !== this.deps.targetKey()) return false;
		const targetProjectPath = this.deps.targetProjectPath();
		return !targetProjectPath || targetProjectPath === guard.projectPath;
	}

	private isCurrentFileLoadGuard(guard: GitWorkbenchLoadGuard): boolean {
		return (
			this.isCurrentLoadGuard(guard) &&
			this.deps.activeTab() === guard.tab &&
			this.deps.contextLines() === guard.contextLines
		);
	}

	private cacheKey(
		filePath: string,
		tab = this.deps.activeTab(),
		contextLines = this.deps.contextLines(),
	): ReviewDataKey {
		return `${tab}|${contextLines}|${filePath}`;
	}

	private cacheGet(
		filePath: string,
		tab = this.deps.activeTab(),
		contextLines = this.deps.contextLines(),
	): GitFileReviewData | null {
		return this.reviewCache.get(this.cacheKey(filePath, tab, contextLines)) ?? null;
	}

	private cacheSet(
		filePath: string,
		data: GitFileReviewData,
		tab = this.deps.activeTab(),
		contextLines = this.deps.contextLines(),
	): void {
		this.reviewCache.set(this.cacheKey(filePath, tab, contextLines), data);
	}

	private async loadFileOnce(
		projectPath: string,
		filePath: string,
		tab: GitDiffTab,
		contextLines: number,
	): Promise<GitFileReviewData | null> {
		const key = this.cacheKey(filePath, tab, contextLines);
		const existing = this.inFlightByKey.get(key);
		if (existing) return existing;

		const promise = getGitFileReviewData(projectPath, filePath, tab, contextLines)
			.then((data) => {
				this.cacheSet(filePath, data, tab, contextLines);
				return data;
			})
			.finally(() => {
				this.inFlightByKey.delete(key);
			});
		this.inFlightByKey.set(key, promise);
		return promise;
	}

	private markBatchFileInFlight(
		filePath: string,
		tab: GitDiffTab,
		contextLines: number,
	): ReviewDataKey {
		const key = this.cacheKey(filePath, tab, contextLines);
		const promise = new Promise<GitFileReviewData | null>((resolve) => {
			this.batchResolversByKey.set(key, resolve);
		});
		this.inFlightByKey.set(key, promise);
		return key;
	}

	private resolveBatchFile(key: ReviewDataKey, data: GitFileReviewData | null): void {
		this.batchResolversByKey.get(key)?.(data);
		this.batchResolversByKey.delete(key);
		this.inFlightByKey.delete(key);
	}

	private clearInFlightLoads(): void {
		for (const resolve of this.batchResolversByKey.values()) resolve(null);
		this.batchResolversByKey.clear();
		this.inFlightByKey.clear();
	}

	private pumpFileQueue(): void {
		const generation = this.loadGeneration;
		if (this.pendingLoadQueue.length === 0) return;

		const tab = this.deps.activeTab();
		const contextLines = this.deps.contextLines();
		const projectPath = this.loadProjectPath;
		// Allows independent batches to overlap while per-key promises suppress duplicate file loads.
		const batch = this.pendingLoadQueue.splice(0, 8).filter((filePath) => {
			if (this.cacheGet(filePath, tab, contextLines)) return false;
			return !this.inFlightByKey.has(this.cacheKey(filePath, tab, contextLines));
		});
		if (batch.length === 0) {
			this.pumpFileQueue();
			return;
		}
		const keysByFile = new Map<string, ReviewDataKey>();
		for (const filePath of batch) {
			keysByFile.set(filePath, this.markBatchFileInFlight(filePath, tab, contextLines));
		}

		void getGitFileReviewDataBatch(projectPath, batch, tab, contextLines)
			.then((result) => {
				if (generation !== this.loadGeneration) {
					for (const key of keysByFile.values()) this.resolveBatchFile(key, null);
					return;
				}
				const next = { ...this.reviewDataByPath };
				for (const [filePath, data] of Object.entries(result.files)) {
					this.cacheSet(filePath, data, tab, contextLines);
					next[filePath] = data;
					const key = keysByFile.get(filePath);
					if (key) this.resolveBatchFile(key, data);
				}
				for (const [filePath, message] of Object.entries(result.errors)) {
					const errorData = createDiffLoadError(filePath, tab, message || 'Failed to load diff');
					next[filePath] = errorData;
					const key = keysByFile.get(filePath);
					if (key) this.resolveBatchFile(key, errorData);
				}
				for (const [filePath, key] of keysByFile) {
					if (result.files[filePath] || result.errors[filePath]) continue;
					const errorData = createDiffLoadError(filePath, tab, 'Failed to load diff');
					next[filePath] = errorData;
					this.resolveBatchFile(key, errorData);
				}
				this.reviewDataByPath = next;
			})
			.catch(() => {
				if (generation !== this.loadGeneration) {
					for (const key of keysByFile.values()) this.resolveBatchFile(key, null);
					return;
				}
				const next = { ...this.reviewDataByPath };
				for (const filePath of batch) {
					const errorData = createDiffLoadError(filePath, tab, 'Failed to load diff');
					next[filePath] = errorData;
					const key = keysByFile.get(filePath);
					if (key) this.resolveBatchFile(key, errorData);
				}
				this.reviewDataByPath = next;
			})
			.finally(() => {
				if (generation === this.loadGeneration) this.pumpFileQueue();
			});
	}
}

function createDiffLoadError(filePath: string, tab: GitDiffTab, error: string): GitFileReviewData {
	return {
		path: filePath,
		mode: tab === 'staged' ? 'staged' : 'working',
		isBinary: false,
		truncated: false,
		contentBefore: '',
		contentAfter: '',
		diffOps: [],
		hunks: [],
		error,
	};
}
