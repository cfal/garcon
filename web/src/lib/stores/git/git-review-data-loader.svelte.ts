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

export class GitReviewDataLoader {
	selectedFile = $state<string | null>(null);
	diffScrollRequest = $state<{ filePath: string; token: number } | null>(null);
	reviewDataByPath = $state<Record<string, GitFileReviewData>>({});
	isLoadingFile = $state(false);

	private inFlightFiles = new Set<string>();
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
			const data = await getGitFileReviewData(projectPath, filePath, tab, contextLines);
			if (!this.isCurrentFileLoadGuard(guard)) return;
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

		const seeded: Record<string, GitFileReviewData> = {};
		const toFetch: string[] = [];

		for (const filePath of filePaths) {
			const cached = this.cacheGet(filePath);
			if (cached) {
				if (!this.reviewDataByPath[filePath]) seeded[filePath] = cached;
				continue;
			}
			if (this.inFlightFiles.has(filePath)) continue;
			toFetch.push(filePath);
		}

		if (Object.keys(seeded).length > 0) {
			this.reviewDataByPath = { ...this.reviewDataByPath, ...seeded };
		}

		this.pendingLoadQueue = toFetch;
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
	}

	clearForDisplayChange(): void {
		this.reviewDataByPath = {};
		this.pendingLoadQueue = [];
		this.isLoadingFile = false;
		this.loadGeneration++;
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
		this.inFlightFiles.clear();
		this.loadGeneration++;
		this.reviewCache.clear();
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
	): string {
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

	private pumpFileQueue(): void {
		const generation = this.loadGeneration;
		if (this.inFlightFiles.size > 0 || this.pendingLoadQueue.length === 0) return;

		const tab = this.deps.activeTab();
		const contextLines = this.deps.contextLines();
		const projectPath = this.loadProjectPath;
		const batch = this.pendingLoadQueue.splice(0, 8);
		for (const filePath of batch) this.inFlightFiles.add(filePath);

		void getGitFileReviewDataBatch(projectPath, batch, tab, contextLines)
			.then((result) => {
				if (generation !== this.loadGeneration) return;
				const next = { ...this.reviewDataByPath };
				for (const [filePath, data] of Object.entries(result.files)) {
					this.cacheSet(filePath, data, tab, contextLines);
					next[filePath] = data;
				}
				for (const [filePath, message] of Object.entries(result.errors)) {
					next[filePath] = createDiffLoadError(filePath, tab, message || 'Failed to load diff');
				}
				this.reviewDataByPath = next;
			})
			.catch(() => {
				if (generation !== this.loadGeneration) return;
				const next = { ...this.reviewDataByPath };
				for (const filePath of batch) {
					next[filePath] = createDiffLoadError(filePath, tab, 'Failed to load diff');
				}
				this.reviewDataByPath = next;
			})
			.finally(() => {
				for (const filePath of batch) this.inFlightFiles.delete(filePath);
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
