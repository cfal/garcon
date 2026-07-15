import {
	getGitBlame,
	getGitCompare,
	getGitConflictDetails,
	getGitConflicts,
	getGitFileHistory,
	getGitGraph,
	getGitStashes,
	gitAcceptConflictSide,
	gitApplyStash,
	gitCreateStash,
	gitDropStash,
	gitMarkConflictResolved,
	gitPopStash,
	type GitBlameLine,
	type GitCompareFile,
	type GitConflictDetails,
	type GitConflictFile,
	type GitFileHistoryEntry,
	type GitGraphCommit,
	type GitStashEntry,
} from '$lib/api/git.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import type { GitWorkbenchMutationRunner } from './git-workbench-types';

export type GitInspectorView = 'none' | 'conflicts' | 'stash' | 'history' | 'graph';

export interface GitPorcelainDeps {
	selectedFile: () => string | null;
	refreshAfterMutation: (projectPath: string) => Promise<void>;
	surfaceError: (message: string) => void;
	ensureFreshForGitMutation: () => boolean;
	isCurrentTarget: (projectPath: string) => boolean;
	runGitMutation: GitWorkbenchMutationRunner;
}

interface PorcelainLoadContext {
	requestId: number;
	signal: AbortSignal;
}

export class GitPorcelainState {
	inspectorView = $state<GitInspectorView>('none');
	isLoading = $state(false);
	conflicts = $state<GitConflictFile[]>([]);
	conflictDetails = $state<GitConflictDetails | null>(null);
	stashes = $state<GitStashEntry[]>([]);
	fileHistory = $state<GitFileHistoryEntry[]>([]);
	blameLines = $state<GitBlameLine[]>([]);
	blameTruncated = $state(false);
	graphCommits = $state<GitGraphCommit[]>([]);
	compareFiles = $state<GitCompareFile[]>([]);
	compareBase = $state('HEAD~1');
	compareHead = $state('HEAD');
	stashMessage = $state('');
	stashIncludeUntracked = $state(false);
	private activeLoadId = 0;
	private activeLoadAbort: AbortController | null = null;

	constructor(private readonly deps: GitPorcelainDeps) {}

	setInspectorView(view: GitInspectorView): void {
		this.inspectorView = this.inspectorView === view ? 'none' : view;
	}

	async loadCurrentView(projectPath: string): Promise<void> {
		const context = this.beginTrackedLoad();
		try {
			if (this.inspectorView === 'conflicts') await this.loadConflicts(projectPath, context);
			else if (this.inspectorView === 'stash') await this.loadStashes(projectPath, context);
			else if (this.inspectorView === 'history') await this.loadHistory(projectPath, context);
			else if (this.inspectorView === 'graph') await this.loadGraph(projectPath, context);
		} finally {
			if (this.activeLoadId === context.requestId) this.activeLoadAbort = null;
		}
	}

	cancelActiveLoad(): void {
		this.activeLoadAbort?.abort();
		this.activeLoadAbort = null;
		this.activeLoadId += 1;
	}

	async loadConflicts(projectPath: string, context?: PorcelainLoadContext): Promise<void> {
		await this.withLoading(
			'Failed to load conflicts',
			async () => {
				const result = await getGitConflicts(projectPath, { signal: context?.signal });
				if (!this.isActiveLoad(context)) return;
				const conflicts = result.conflicts;
				let details: GitConflictDetails | null = null;
				if (conflicts.length > 0) {
					details = await getGitConflictDetails(projectPath, conflicts[0].path, {
						signal: context?.signal,
					});
				}
				if (!this.isActiveLoad(context)) return;
				this.conflicts = conflicts;
				if (conflicts.length > 0) {
					this.conflictDetails = details;
				} else {
					this.conflictDetails = null;
				}
			},
			context,
		);
	}

	async selectConflict(projectPath: string, filePath: string): Promise<void> {
		this.cancelActiveLoad();
		await this.withLoading('Failed to load conflict details', async () => {
			this.conflictDetails = await getGitConflictDetails(projectPath, filePath);
		});
	}

	async acceptConflictSide(
		projectPath: string,
		filePath: string,
		side: 'ours' | 'theirs',
	): Promise<void> {
		if (!this.deps.ensureFreshForGitMutation()) return;
		this.cancelActiveLoad();
		await this.withLoading('Failed to accept conflict side', async () => {
			await this.deps.runGitMutation(projectPath, async () => {
				const result = await gitAcceptConflictSide(projectPath, filePath, side);
				if (result.success && this.deps.isCurrentTarget(projectPath)) {
					await this.loadConflicts(projectPath);
					await this.deps.refreshAfterMutation(projectPath);
				}
			});
		});
	}

	async markConflictResolved(projectPath: string, filePath: string): Promise<void> {
		if (!this.deps.ensureFreshForGitMutation()) return;
		this.cancelActiveLoad();
		await this.withLoading('Failed to mark conflict resolved', async () => {
			await this.deps.runGitMutation(projectPath, async () => {
				const result = await gitMarkConflictResolved(projectPath, filePath);
				if (result.success && this.deps.isCurrentTarget(projectPath)) {
					await this.loadConflicts(projectPath);
					await this.deps.refreshAfterMutation(projectPath);
				}
			});
		});
	}

	async loadStashes(projectPath: string, context?: PorcelainLoadContext): Promise<void> {
		await this.withLoading(
			'Failed to load stashes',
			async () => {
				const result = await getGitStashes(projectPath, { signal: context?.signal });
				if (!this.isActiveLoad(context)) return;
				this.stashes = result.stashes;
			},
			context,
		);
	}

	async createStash(projectPath: string): Promise<void> {
		if (!this.deps.ensureFreshForGitMutation()) return;
		this.cancelActiveLoad();
		await this.withLoading('Failed to create stash', async () => {
			await this.deps.runGitMutation(projectPath, async () => {
				const result = await gitCreateStash(
					projectPath,
					this.stashMessage,
					this.stashIncludeUntracked,
				);
				if (result.success && this.deps.isCurrentTarget(projectPath)) {
					this.stashMessage = '';
					await this.loadStashes(projectPath);
					await this.deps.refreshAfterMutation(projectPath);
				}
			});
		});
	}

	async applyStash(projectPath: string, stashRef: string): Promise<void> {
		if (!this.deps.ensureFreshForGitMutation()) return;
		this.cancelActiveLoad();
		await this.withLoading('Failed to apply stash', async () => {
			await this.deps.runGitMutation(projectPath, async () => {
				const result = await gitApplyStash(projectPath, stashRef);
				if (result.success && this.deps.isCurrentTarget(projectPath)) {
					await this.deps.refreshAfterMutation(projectPath);
				}
			});
		});
	}

	async popStash(projectPath: string, stashRef: string): Promise<void> {
		if (!this.deps.ensureFreshForGitMutation()) return;
		this.cancelActiveLoad();
		await this.withLoading('Failed to pop stash', async () => {
			await this.deps.runGitMutation(projectPath, async () => {
				const result = await gitPopStash(projectPath, stashRef);
				if (result.success && this.deps.isCurrentTarget(projectPath)) {
					await this.loadStashes(projectPath);
					await this.deps.refreshAfterMutation(projectPath);
				}
			});
		});
	}

	async dropStash(projectPath: string, stashRef: string): Promise<void> {
		if (!this.deps.ensureFreshForGitMutation()) return;
		this.cancelActiveLoad();
		await this.withLoading('Failed to drop stash', async () => {
			await this.deps.runGitMutation(projectPath, async () => {
				const result = await gitDropStash(projectPath, stashRef);
				if (result.success && this.deps.isCurrentTarget(projectPath)) {
					await this.loadStashes(projectPath);
				}
			});
		});
	}

	async loadHistory(projectPath: string, context?: PorcelainLoadContext): Promise<void> {
		const filePath = this.deps.selectedFile();
		if (!filePath) {
			if (!this.isActiveLoad(context)) return;
			this.fileHistory = [];
			this.blameLines = [];
			this.blameTruncated = false;
			return;
		}
		await this.withLoading(
			'Failed to load file history',
			async () => {
				const [history, blame] = await Promise.all([
					getGitFileHistory(projectPath, filePath, 50, { signal: context?.signal }),
					getGitBlame(projectPath, filePath, 'HEAD', 300, { signal: context?.signal }),
				]);
				if (!this.isActiveLoad(context) || this.deps.selectedFile() !== filePath) return;
				this.fileHistory = history.commits;
				this.blameLines = blame.lines;
				this.blameTruncated = blame.truncated;
			},
			context,
		);
	}

	async loadGraph(projectPath: string, context?: PorcelainLoadContext): Promise<void> {
		await this.withLoading(
			'Failed to load commit graph',
			async () => {
				const result = await getGitGraph(projectPath, 200, { signal: context?.signal });
				if (!this.isActiveLoad(context)) return;
				this.graphCommits = result.commits;
			},
			context,
		);
	}

	async compareRefs(projectPath: string): Promise<void> {
		this.cancelActiveLoad();
		await this.withLoading('Failed to compare refs', async () => {
			const result = await getGitCompare(projectPath, this.compareBase, this.compareHead);
			this.compareFiles = result.files;
		});
	}

	reset(): void {
		this.inspectorView = 'none';
		this.isLoading = false;
		this.conflicts = [];
		this.conflictDetails = null;
		this.stashes = [];
		this.fileHistory = [];
		this.blameLines = [];
		this.blameTruncated = false;
		this.graphCommits = [];
		this.compareFiles = [];
		this.compareBase = 'HEAD~1';
		this.compareHead = 'HEAD';
		this.stashMessage = '';
		this.stashIncludeUntracked = false;
		this.cancelActiveLoad();
	}

	private beginTrackedLoad(): PorcelainLoadContext {
		this.activeLoadAbort?.abort();
		const controller = new AbortController();
		const requestId = this.activeLoadId + 1;
		this.activeLoadId = requestId;
		this.activeLoadAbort = controller;
		return { requestId, signal: controller.signal };
	}

	private isActiveLoad(context?: PorcelainLoadContext): boolean {
		return !context || (this.activeLoadId === context.requestId && !context.signal.aborted);
	}

	private async withLoading(
		label: string,
		action: () => Promise<void>,
		context?: PorcelainLoadContext,
	): Promise<void> {
		if (this.isActiveLoad(context)) this.isLoading = true;
		try {
			await action();
		} catch (error) {
			if (isAbortError(error)) return;
			if (this.isActiveLoad(context)) {
				this.deps.surfaceError(
					`${label}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} finally {
			if (this.isActiveLoad(context)) this.isLoading = false;
		}
	}
}
