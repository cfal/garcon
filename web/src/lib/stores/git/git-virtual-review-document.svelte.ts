import {
	getGitReviewFileBodies,
	type GitDiffTab,
	type GitRenderedDiffRow,
	type GitReviewCommentDraft,
	type GitReviewDocumentSummary,
	type GitReviewFileBody,
	type GitReviewFileSummary,
	type GitReviewLimitReason,
} from '$lib/api/git.js';
import {
	buildCommentsByLineKey,
	buildSplitDiffRows,
	buildSplitDiffRowViews,
	buildUnifiedDiffRowsFromRenderedRows,
	buildUnifiedDiffRowViews,
	getSelectableLineKeys,
	type SplitDiffRowView,
	type UnifiedDiffRowView,
} from '$lib/components/git/git-diff-rows';
import type { DiffMode, GitDiffActionTarget } from './git-workbench-types';
import type { CommentComposerState } from './git-review-drafts.svelte';
import type { GitWorkbenchLoadGuard } from './git-workbench-types';

export type GitVirtualReviewRow =
	| GitVirtualFileHeaderRow
	| GitVirtualFilePlaceholderRow
	| GitVirtualFileLimitRow
	| GitVirtualUnifiedRow
	| GitVirtualSplitRow
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
	reason: GitReviewLimitReason;
}

export interface GitVirtualUnifiedRow extends GitVirtualRowBase {
	kind: 'unified-row';
	file: GitReviewFileSummary;
	view: UnifiedDiffRowView;
	actionTarget: GitDiffActionTarget;
	selectableLineKeys: string[];
}

export interface GitVirtualSplitRow extends GitVirtualRowBase {
	kind: 'split-row';
	file: GitReviewFileSummary;
	view: SplitDiffRowView;
	actionTarget: GitDiffActionTarget;
	selectableLineKeys: string[];
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
	diffMode: () => DiffMode;
	contextLines: () => number;
	visibleFilePaths: () => string[];
	selectedFile: () => string | null;
	selectedLineKeys: () => Set<string>;
	commentsByFile: () => Record<string, GitReviewCommentDraft[]>;
	composerState: () => CommentComposerState;
	surfaceError: (message: string) => void;
	markExternallyStale: () => void;
}

export interface BuildVirtualRowsOptions {
	summary: GitReviewDocumentSummary;
	visibleFilePaths: string[];
	fileBodies: Record<string, GitReviewFileBody>;
	loadingBodies: Set<string>;
	focusedFilePath: string | null;
	diffMode: DiffMode;
	activeTab: GitDiffTab;
	contextLines: number;
	commentsByFile: Record<string, GitReviewCommentDraft[]>;
	composerState: CommentComposerState;
	selectedLineKeys: Set<string>;
	readOnly?: boolean;
}

type BodyCacheKey = `${string}|${GitDiffTab}|${number}|${string}|${string}`;

const BODY_BATCH_SIZE = 24;
const DEFAULT_ROW_HEIGHT = 22;

export class GitVirtualReviewDocumentController {
	summary = $state<GitReviewDocumentSummary | null>(null);
	fileBodies = $state<Record<string, GitReviewFileBody>>({});
	loadingBodies = $state(new Set<string>());
	scrollRequest = $state<{ filePath: string; token: number } | null>(null);

	private bodyCache = new Map<BodyCacheKey, GitReviewFileBody>();
	private pendingBodyQueue: string[] = [];
	private bodyBatchController: AbortController | null = null;
	private bodyBatchFiles = new Set<string>();
	private loadGeneration = 0;
	private scrollToken = 0;

	virtualRows = $derived.by<GitVirtualReviewRow[]>(() => {
		if (!this.summary) return [];
		return buildVirtualRows({
			summary: this.summary,
			visibleFilePaths: this.deps.visibleFilePaths(),
			fileBodies: this.fileBodies,
			loadingBodies: this.loadingBodies,
			focusedFilePath: this.deps.selectedFile(),
			diffMode: this.deps.diffMode(),
			activeTab: this.deps.activeTab(),
			contextLines: this.deps.contextLines(),
			commentsByFile: this.deps.commentsByFile(),
			composerState: this.deps.composerState(),
			selectedLineKeys: this.deps.selectedLineKeys(),
			readOnly: false,
		});
	});

	fileRowIndex = $derived.by(() => {
		const index = new Map<string, number>();
		this.virtualRows.forEach((row, rowIndex) => {
			if (row.kind === 'file-header') index.set(row.filePath, rowIndex);
		});
		return index;
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
		this.pendingBodyQueue = [];
		this.loadingBodies = new Set();
		this.loadGeneration++;
		this.summary = summary;
		if (summary) {
			this.pruneBodiesToSummary(summary);
		} else {
			this.fileBodies = {};
		}
	}

	setVisibleRows(projectPath: string, rows: GitVirtualReviewRow[]): void {
		if (!this.summary) return;
		const filePaths = Array.from(new Set(rows.map((row) => row.filePath).filter(Boolean)));
		this.requestBodies(projectPath, filePaths);
	}

	focusFile(projectPath: string, filePath: string): void {
		this.requestBodies(projectPath, [filePath]);
		this.requestScrollToFile(filePath);
	}

	requestScrollToFile(filePath: string): void {
		this.scrollToken += 1;
		this.scrollRequest = { filePath, token: this.scrollToken };
	}

	requestBodies(projectPath: string, filePaths: string[]): void {
		if (!this.summary) return;
		const guard = this.createLoadGuard(projectPath);
		const uniquePaths = unique(filePaths).filter(Boolean);
		this.seedCachedBodies(uniquePaths, guard);
		const toFetch = uniquePaths.filter((filePath) => this.shouldLoadBody(filePath, guard));
		if (toFetch.length === 0) return;

		this.markLoading(toFetch, true);
		this.prioritizeBodyQueue(toFetch);
		this.abortOffscreenBodyBatch(toFetch);
		this.pumpBodyQueue(projectPath, guard.generation);
	}

	refreshAllData(): void {
		this.bodyCache.clear();
		this.applySummary(null);
	}

	clearForDisplayChange(): void {
		this.summary = null;
		this.fileBodies = {};
		this.pendingBodyQueue = [];
		this.loadingBodies = new Set();
		this.loadGeneration++;
		this.clearBodyInFlightLoads();
	}

	invalidateFile(filePath: string): void {
		for (const key of Array.from(this.bodyCache.keys())) {
			if (key.endsWith(`|${filePath}`)) this.bodyCache.delete(key);
		}
		this.fileBodies = Object.fromEntries(
			Object.entries(this.fileBodies).filter(([candidate]) => candidate !== filePath),
		);
	}

	pruneToFilePaths(paths: Set<string>): void {
		this.fileBodies = Object.fromEntries(
			Object.entries(this.fileBodies).filter(([filePath]) => paths.has(filePath)),
		);
		for (const key of Array.from(this.bodyCache.keys())) {
			const filePath = key.split('|').slice(4).join('|');
			if (!paths.has(filePath)) this.bodyCache.delete(key);
		}
	}

	reset(): void {
		this.summary = null;
		this.fileBodies = {};
		this.loadingBodies = new Set();
		this.scrollRequest = null;
		this.bodyCache.clear();
		this.pendingBodyQueue = [];
		this.loadGeneration++;
		this.clearBodyInFlightLoads();
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

	private pruneBodiesToSummary(summary: GitReviewDocumentSummary): void {
		const files = new Map(summary.files.map((file) => [file.path, file]));
		this.fileBodies = Object.fromEntries(
			Object.entries(this.fileBodies).filter(([filePath, body]) => {
				const file = files.get(filePath);
				return Boolean(file && file.bodyFingerprint === body.bodyFingerprint);
			}),
		);
	}

	private shouldLoadBody(filePath: string, guard: GitWorkbenchLoadGuard): boolean {
		const file = this.summaryForFile(filePath);
		if (!file || file.bodyState !== 'unloaded') return false;
		if (this.fileBodies[filePath]) return false;
		if (this.cacheGet(file, guard)) return false;
		if (this.loadingBodies.has(filePath)) return false;
		if (this.pendingBodyQueue.includes(filePath)) return false;
		if (this.bodyBatchFiles.has(filePath)) return false;
		return true;
	}

	private seedCachedBodies(filePaths: string[], guard: GitWorkbenchLoadGuard): void {
		const seeded: Record<string, GitReviewFileBody> = {};
		for (const filePath of filePaths) {
			const file = this.summaryForFile(filePath);
			if (!file || this.fileBodies[filePath]) continue;
			const cached = this.cacheGet(file, guard);
			if (cached) seeded[filePath] = cached;
		}
		if (Object.keys(seeded).length > 0) this.fileBodies = { ...this.fileBodies, ...seeded };
	}

	private prioritizeBodyQueue(filePaths: string[]): void {
		const requested = new Set(filePaths);
		const stalePending = this.pendingBodyQueue.filter((filePath) => !requested.has(filePath));
		this.pendingBodyQueue = [...filePaths, ...stalePending];
	}

	private abortOffscreenBodyBatch(visiblePaths: string[]): void {
		if (!this.bodyBatchController) return;
		const visible = new Set(visiblePaths);
		const hasVisibleInFlight = Array.from(this.bodyBatchFiles).some((filePath) => visible.has(filePath));
		if (!hasVisibleInFlight) this.bodyBatchController.abort();
	}

	private pumpBodyQueue(projectPath: string, generation: number): void {
		if (!this.summary || this.bodyBatchController || this.pendingBodyQueue.length === 0) return;

		const guard = this.createLoadGuard(projectPath);
		if (guard.generation !== generation) return;
		const batchSize = this.summary.limits.maxBodyBatchFiles || BODY_BATCH_SIZE;
		const batch = this.pendingBodyQueue.splice(0, batchSize).filter((filePath) =>
			this.shouldStartBodyLoad(filePath, guard),
		);
		if (batch.length === 0) {
			this.pumpBodyQueue(projectPath, generation);
			return;
		}

		const controller = new AbortController();
		this.bodyBatchController = controller;
		this.bodyBatchFiles = new Set(batch);

		void getGitReviewFileBodies(projectPath, this.summary.documentId, batch, guard.tab, guard.contextLines, {
			signal: controller.signal,
		})
			.then((result) => {
				if (!this.isCurrentGuard(guard)) return;
				const next = { ...this.fileBodies };
				for (const filePath of batch) {
					const file = this.summaryForFile(filePath);
					const body = result.files[filePath];
					if (!file || !body) continue;
					if (body.bodyFingerprint !== file.bodyFingerprint) {
						this.deps.markExternallyStale();
						continue;
					}
					this.cacheSet(file, guard, body);
					next[filePath] = body;
				}
				this.fileBodies = next;
			})
			.catch((error) => {
				if (isAbortError(error) || !this.isCurrentGuard(guard)) return;
				this.deps.surfaceError(`Failed to load diff: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				if (this.bodyBatchController !== controller) return;
				this.bodyBatchController = null;
				this.bodyBatchFiles = new Set();
				this.markLoading(batch, false);
				if (generation === this.loadGeneration) this.pumpBodyQueue(projectPath, generation);
			});
	}

	private shouldStartBodyLoad(filePath: string, guard: GitWorkbenchLoadGuard): boolean {
		const file = this.summaryForFile(filePath);
		if (!file || file.bodyState !== 'unloaded') return false;
		if (this.fileBodies[filePath]) return false;
		if (this.cacheGet(file, guard)) return false;
		if (this.bodyBatchFiles.has(filePath)) return false;
		return true;
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
		return `${this.summary?.documentId ?? ''}|${guard.tab}|${guard.contextLines}|${file.bodyFingerprint}|${file.path}`;
	}

	private cacheGet(file: GitReviewFileSummary, guard: GitWorkbenchLoadGuard): GitReviewFileBody | null {
		return this.bodyCache.get(this.cacheKey(file, guard)) ?? null;
	}

	private cacheSet(file: GitReviewFileSummary, guard: GitWorkbenchLoadGuard, body: GitReviewFileBody): void {
		this.bodyCache.set(this.cacheKey(file, guard), body);
	}

	private clearBodyInFlightLoads(): void {
		this.bodyBatchController?.abort();
		this.bodyBatchController = null;
		this.bodyBatchFiles = new Set();
	}
}

export function buildVirtualRows(options: BuildVirtualRowsOptions): GitVirtualReviewRow[] {
	const rows: GitVirtualReviewRow[] = [];
	const summaryByPath = new Map(options.summary.files.map((file) => [file.path, file]));
	const orderedFiles = options.visibleFilePaths.length > 0
		? options.visibleFilePaths
				.map((filePath) => summaryByPath.get(filePath))
				.filter((file): file is GitReviewFileSummary => Boolean(file))
		: options.summary.files;

	for (const file of orderedFiles) {
		rows.push({
			kind: 'file-header',
			id: fileHeaderRowId(file.path),
			filePath: file.path,
			estimatedHeight: 42,
			file,
			isFocused: options.focusedFilePath === file.path,
		});

		const body = options.fileBodies[file.path];
		if (file.isBinary || body?.bodyState === 'binary') {
			rows.push(fileLimitRow(file, 'binary', 'Binary file', body?.limitMessage ?? file.limitMessage ?? 'Binary diff is not available.'));
			continue;
		}
		if (file.isTooLarge || body?.bodyState === 'too-large') {
			rows.push(fileLimitRow(
				file,
				body?.limitReason ?? file.limitReason ?? 'file-too-many-rows',
				'Large diff',
				body?.limitMessage ?? file.limitMessage ?? 'Changes are too large to render inline.',
			));
			continue;
		}
		if (!body) {
			rows.push({
				kind: 'file-placeholder',
				id: filePlaceholderRowId(file.path),
				filePath: file.path,
				estimatedHeight: Math.max(96, Math.min(720, file.estimatedRows * DEFAULT_ROW_HEIGHT)),
				file,
				loadState: options.loadingBodies.has(file.path) ? 'loading' : 'unloaded',
			});
			continue;
		}
		if (body.error || body.bodyState === 'error') {
			rows.push(fileLimitRow(file, 'git-timeout', 'Diff failed', body.error ?? 'Failed to load diff.'));
			continue;
		}
		rows.push(...bodyRows(file, body.rows, options));
	}

	if (options.summary.collectionLimit) {
		rows.push({
			kind: 'collection-limit',
			id: 'collection-limit',
			filePath: '',
			estimatedHeight: 112,
			title: 'Diff limit reached',
			message: options.summary.collectionLimit.message,
		});
	}

	return rows;
}

function bodyRows(
	file: GitReviewFileSummary,
	renderedRows: GitRenderedDiffRow[],
	options: BuildVirtualRowsOptions,
): GitVirtualReviewRow[] {
	const actionTarget: GitDiffActionTarget = {
		filePath: file.path,
		tab: options.activeTab,
		mode: options.activeTab === 'unstaged' ? 'stage' : 'unstage',
		contextLines: options.contextLines,
	};
	const commentsByLineKey = buildCommentsByLineKey(options.commentsByFile[file.path] ?? []);
	const composerTarget = options.composerState.open && options.composerState.filePath === file.path
		? {
				open: options.composerState.open,
				filePath: options.composerState.filePath,
				side: options.composerState.side,
				line: options.composerState.line,
				body: options.composerState.body,
				severity: options.composerState.severity,
			}
		: null;
	const unifiedRows = buildUnifiedDiffRowsFromRenderedRows(renderedRows);
	const selectableLineKeys = getSelectableLineKeys(unifiedRows, file.path, options.activeTab);

	if (options.diffMode === 'split') {
		return buildSplitDiffRowViews({
			rows: buildSplitDiffRows(unifiedRows),
			filePath: file.path,
			activeTab: options.activeTab,
			readOnly: options.readOnly === true,
			selectedLineKeys: options.selectedLineKeys,
			commentsByLineKey,
			composerTarget,
		}).map((view) => ({
			kind: 'split-row',
			id: diffRowId(file.path, view.key, 'split'),
			filePath: file.path,
			estimatedHeight: estimateViewHeight(view.isHunkHeader, view.comments.length, view.showComposer),
			file,
			view,
			actionTarget,
			selectableLineKeys,
		}));
	}

	return buildUnifiedDiffRowViews({
		rows: unifiedRows,
		filePath: file.path,
		activeTab: options.activeTab,
		readOnly: options.readOnly === true,
		selectedLineKeys: options.selectedLineKeys,
		commentsByLineKey,
		composerTarget,
	}).map((view) => ({
		kind: 'unified-row',
		id: diffRowId(file.path, view.key, 'unified'),
		filePath: file.path,
		estimatedHeight: estimateViewHeight(view.isHunkHeader, view.comments.length, view.showComposer),
		file,
		view,
		actionTarget,
		selectableLineKeys,
	}));
}

function fileLimitRow(
	file: GitReviewFileSummary,
	reason: GitReviewLimitReason,
	title: string,
	message: string,
): GitVirtualFileLimitRow {
	return {
		kind: 'file-limit',
		id: `file:${encodeURIComponent(file.path)}:limit:${reason}`,
		filePath: file.path,
		estimatedHeight: 112,
		file,
		title,
		message,
		reason,
	};
}

function estimateViewHeight(isHunkHeader: boolean, comments: number, showComposer: boolean): number {
	return (isHunkHeader ? 28 : DEFAULT_ROW_HEIGHT) + comments * 72 + (showComposer ? 180 : 0);
}

function fileHeaderRowId(filePath: string): string {
	return `file:${encodeURIComponent(filePath)}:header`;
}

function filePlaceholderRowId(filePath: string): string {
	return `file:${encodeURIComponent(filePath)}:placeholder`;
}

function diffRowId(filePath: string, rowKey: string, mode: DiffMode): string {
	return `file:${encodeURIComponent(filePath)}:${mode}:row:${rowKey}`;
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values));
}

function isAbortError(error: unknown): boolean {
	return (
		error instanceof DOMException && error.name === 'AbortError'
	) || (
		typeof error === 'object' &&
		error !== null &&
		'name' in error &&
		(error as { name?: unknown }).name === 'AbortError'
	);
}
