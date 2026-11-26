import {
	getGitReviewFileBodies,
	type GitDiffTab,
	type GitReviewDocumentSummary,
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
import { gitDocumentKey, type GitReviewDocumentRef } from '$lib/api/git-client.js';
import { GitReviewBodyStore } from './git-review-body-store.svelte.js';
import {
	buildGitVirtualReviewRowSource,
	emptyGitVirtualReviewRowSource,
	type GitVirtualReviewRowSource,
} from './git-virtual-review-row-source.js';
import { type GitReviewBodyDemand, type GitReviewDemandOutcome } from './git-review-body-demand.js';
import { GitDiffSyntaxController } from './git-diff-syntax-controller.svelte.js';

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
	invalidateSelections: () => void;
}

export type GitVirtualDocumentSummary = Pick<
	GitReviewDocumentSummary,
	'documentId' | 'project' | 'context' | 'files' | 'limits' | 'collectionLimit'
> & { document?: GitReviewDocumentRef };

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

export class GitVirtualReviewDocumentController {
	summary = $state.raw<GitReviewDocumentSummary | null>(null);
	scrollRequest = $state<{ filePath: string; token: number } | null>(null);
	diffMode = $state<DiffMode>('unified');
	contextLines = $state(5);
	readonly bodies: GitReviewBodyStore;
	private loadGeneration = 0;
	private scrollToken = 0;
	private suspended = false;
	private summariesByPath = new Map<string, GitReviewFileSummary>();

	private interaction = $derived.by<GitVirtualRowInteraction>(() => ({
		kind: 'workbench',
		activeTab: this.deps.activeTab(),
		selectedLineKeys: this.deps.selectedLineKeys(),
		composerState: this.deps.composerState(),
	}));

	rowSource = $derived.by<GitVirtualReviewRowSource>(() => {
		if (!this.summary) return emptyGitVirtualReviewRowSource();
		const summary = this.bodies.aggregateLimit
			? { ...this.summary, collectionLimit: this.bodies.aggregateLimit }
			: this.summary;
		const placeholderLimit = this.bodies.aggregateLimit
			? {
					title: m.git_virtual_diff_limit_reached(),
					message: this.bodies.aggregateLimit.message,
					reason: this.bodies.aggregateLimit.reason,
				}
			: undefined;
		const syntaxResults = () => this.bodies.syntax.results;
		const loadingBodies = () => this.loadingBodies;
		const focusedFilePath = () => this.deps.selectedFile();
		const interaction = () => this.interaction;
		return buildGitVirtualReviewRowSource({
			summary,
			visibleFilePaths: this.deps.visibleFilePaths(),
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

	constructor(
		private readonly deps: GitVirtualReviewDocumentDeps,
		syntax = new GitDiffSyntaxController(),
	) {
		this.bodies = new GitReviewBodyStore(syntax, 'workbench', (paths, purpose) => {
			const projectPath = this.deps.targetProjectPath();
			return projectPath ? this.requestBodies(projectPath, paths, purpose) : 'not-ready';
		});
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

	get hasLoading(): boolean {
		return this.loadingBodies.size > 0;
	}

	summaryForFile(filePath: string): GitReviewFileSummary | null {
		return this.summariesByPath.get(filePath) ?? null;
	}

	applySummary(summary: GitReviewDocumentSummary | null, firstBodyCandidates: string[] = []): void {
		this.suspended = false;
		this.deps.invalidateSelections();
		const nextBodies = summary ? this.retainedBodiesForSummary(summary) : {};
		this.loadGeneration++;
		this.summary = summary;
		this.summariesByPath = new Map(summary?.files.map((file) => [file.path, file]));
		if (summary) this.bodies.open(summary, nextBodies);
		else this.bodies.close({ preserveCache: true, preserveDemand: true });
		const projectPath = this.deps.targetProjectPath();
		if (projectPath && summary) this.requestInitialBodies(projectPath, firstBodyCandidates);
		this.bodies.markReadinessChanged();
	}

	handleBodyDemand(demand: GitReviewBodyDemand): void {
		this.bodies.handleDemand(demand);
	}

	markDemandReadinessChanged(): void {
		this.bodies.markReadinessChanged();
	}

	getDemandDebugSnapshot() {
		return this.bodies.getDemandDebugSnapshot();
	}

	focusFile(projectPath: string, filePath: string): void {
		this.bodies.discardError(filePath);
		this.requestBodies(projectPath, [filePath], 'navigation');
		this.requestScrollToFile(filePath);
	}

	requestScrollToFile(filePath: string): void {
		this.scrollToken += 1;
		this.scrollRequest = { filePath, token: this.scrollToken };
	}

	requestInitialBodies(projectPath: string, filePaths: string[]): void {
		this.bodies.requestInitial(filePaths, (paths, purpose) =>
			this.requestBodies(projectPath, paths, purpose),
		);
	}

	requestBodies(
		projectPath: string,
		filePaths: readonly string[],
		purpose: GitReviewBodyPurpose | 'navigation' = 'visible',
	): GitReviewDemandOutcome {
		const summary = this.summary;
		if (!summary || this.suspended) return 'not-ready';
		this.bodies.configure(() => {
			const guard = this.createLoadGuard(projectPath);
			const cacheScope = JSON.stringify([
				gitDocumentKey(summary.document),
				guard.tab,
				guard.contextLines,
			]);
			return {
				cacheScope: () => cacheScope,
				isCurrent: () => this.isCurrentGuard(guard),
				load: (paths, purpose, signal, publish) =>
					getGitReviewFileBodies(
						{ executorId: summary.document.executorId, projectPath },
						summary.document,
						paths,
						guard.tab,
						guard.contextLines,
						{ purpose, signal, onIndexedBodies: publish },
					),
				onError: (error) =>
					this.deps.surfaceError(
						m.git_virtual_load_diff_failed_with_detail({
							detail: error instanceof Error ? error.message : String(error),
						}),
					),
				onStale: (result) => this.deps.markExternallyStale(result.status),
				acceptBody: (file, body, previous) => {
					if (previous && previous.patchDigest !== body.patchDigest)
						this.deps.invalidateSelections();
					if (body.bodyFingerprint === file.bodyFingerprint) return body;
					this.deps.markExternallyStale();
					return null;
				},
				shouldCache: () => true,
			};
		});
		return this.bodies.request(filePaths, purpose);
	}

	refreshAllData(): void {
		this.bodies.close({ preserveDemand: true });
		this.applySummary(null);
	}

	suspend(): void {
		this.suspended = true;
		this.loadGeneration++;
		this.bodies.suspend();
	}

	clearForDisplayChange(): void {
		this.summary = null;
		this.summariesByPath.clear();
		this.loadGeneration++;
		this.bodies.close({ preserveCache: true, preserveDemand: true });
	}

	invalidateFile(filePath: string): void {
		this.bodies.invalidate(filePath);
	}

	pruneToFilePaths(paths: Set<string>): void {
		this.bodies.prune(paths);
	}

	reset(): void {
		this.summary = null;
		this.summariesByPath.clear();
		this.scrollRequest = null;
		this.loadGeneration++;
		this.bodies.close();
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
		if (!this.summary || gitDocumentKey(this.summary.document) !== gitDocumentKey(summary.document))
			return {};
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
}
