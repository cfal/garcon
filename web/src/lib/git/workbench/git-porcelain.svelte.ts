import type { GitProjectTarget } from '$lib/api/git-client.js';
import {
	getGitBlame,
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
	type GitConflictDetails,
	type GitConflictFile,
	type GitFileHistoryEntry,
	type GitGraphCommit,
	type GitStashEntry,
} from '$lib/api/git.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import type { GitWorkbenchMutationRunner } from '$lib/git/workbench/git-workbench-types.js';

export type GitInspectorView = 'none' | 'conflicts' | 'stash' | 'history' | 'graph';

export interface GitPorcelainDeps {
	selectedFile: () => string | null;
	refreshAfterMutation: (project: GitProjectTarget) => Promise<void>;
	surfaceError: (message: string) => void;
	ensureFreshForGitMutation: () => boolean;
	isCurrentTarget: (project: GitProjectTarget) => boolean;
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
	stashMessage = $state('');
	stashIncludeUntracked = $state(false);
	private activeLoadId = 0;
	private activeLoadAbort: AbortController | null = null;

	constructor(private readonly deps: GitPorcelainDeps) {}

	setInspectorView(view: GitInspectorView): void {
		this.inspectorView = this.inspectorView === view ? 'none' : view;
	}

	async loadCurrentView(project: GitProjectTarget): Promise<void> {
		const context = this.beginTrackedLoad();
		try {
			if (this.inspectorView === 'conflicts') await this.loadConflicts(project, context);
			else if (this.inspectorView === 'stash') await this.loadStashes(project, context);
			else if (this.inspectorView === 'history') await this.loadHistory(project, context);
			else if (this.inspectorView === 'graph') await this.loadGraph(project, context);
		} finally {
			if (this.activeLoadId === context.requestId) this.activeLoadAbort = null;
		}
	}

	cancelActiveLoad(): void {
		this.activeLoadAbort?.abort();
		this.activeLoadAbort = null;
		this.activeLoadId += 1;
		this.isLoading = false;
	}

	async loadConflicts(
		project: GitProjectTarget,
		context: PorcelainLoadContext = this.beginTrackedLoad(),
	): Promise<void> {
		await this.withLoading(
			'Failed to load conflicts',
			async () => {
				const result = await getGitConflicts(project, { signal: context?.signal });
				if (!this.isActiveLoad(context)) return;
				const conflicts = result.conflicts;
				let details: GitConflictDetails | null = null;
				if (conflicts.length > 0) {
					details = await getGitConflictDetails(project, conflicts[0].path, {
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

	async selectConflict(project: GitProjectTarget, filePath: string): Promise<void> {
		const context = this.beginTrackedLoad();
		try {
			await this.withLoading(
				'Failed to load conflict details',
				async () => {
					const details = await getGitConflictDetails(project, filePath, {
						signal: context.signal,
					});
					if (!this.isActiveLoad(context)) return;
					this.conflictDetails = details;
				},
				context,
			);
		} finally {
			if (this.activeLoadId === context.requestId) this.activeLoadAbort = null;
		}
	}

	async acceptConflictSide(
		project: GitProjectTarget,
		filePath: string,
		side: 'ours' | 'theirs',
	): Promise<void> {
		if (!this.deps.isCurrentTarget(project) || !this.deps.ensureFreshForGitMutation()) return;
		await this.withLoading('Failed to accept conflict side', async (context) => {
			await this.deps.runGitMutation(project, async () => {
				const result = await gitAcceptConflictSide(project, filePath, side);
				if (result.success && this.isActiveLoad(context) && this.deps.isCurrentTarget(project)) {
					await this.loadConflicts(project, context);
					if (!this.isActiveLoad(context)) return;
					await this.deps.refreshAfterMutation(project);
				}
			});
		});
	}

	async markConflictResolved(project: GitProjectTarget, filePath: string): Promise<void> {
		if (!this.deps.isCurrentTarget(project) || !this.deps.ensureFreshForGitMutation()) return;
		await this.withLoading('Failed to mark conflict resolved', async (context) => {
			await this.deps.runGitMutation(project, async () => {
				const result = await gitMarkConflictResolved(project, filePath);
				if (result.success && this.isActiveLoad(context) && this.deps.isCurrentTarget(project)) {
					await this.loadConflicts(project, context);
					if (!this.isActiveLoad(context)) return;
					await this.deps.refreshAfterMutation(project);
				}
			});
		});
	}

	async loadStashes(
		project: GitProjectTarget,
		context: PorcelainLoadContext = this.beginTrackedLoad(),
	): Promise<void> {
		await this.withLoading(
			'Failed to load stashes',
			async () => {
				const result = await getGitStashes(project, { signal: context?.signal });
				if (!this.isActiveLoad(context)) return;
				this.stashes = result.stashes;
			},
			context,
		);
	}

	async createStash(project: GitProjectTarget): Promise<void> {
		if (!this.deps.isCurrentTarget(project) || !this.deps.ensureFreshForGitMutation()) return;
		await this.withLoading('Failed to create stash', async (context) => {
			await this.deps.runGitMutation(project, async () => {
				const result = await gitCreateStash(project, this.stashMessage, this.stashIncludeUntracked);
				if (result.success && this.isActiveLoad(context) && this.deps.isCurrentTarget(project)) {
					this.stashMessage = '';
					await this.loadStashes(project, context);
					if (!this.isActiveLoad(context)) return;
					await this.deps.refreshAfterMutation(project);
				}
			});
		});
	}

	async applyStash(project: GitProjectTarget, stashRef: string): Promise<void> {
		if (!this.deps.isCurrentTarget(project) || !this.deps.ensureFreshForGitMutation()) return;
		await this.withLoading('Failed to apply stash', async (context) => {
			await this.deps.runGitMutation(project, async () => {
				const result = await gitApplyStash(project, stashRef);
				if (result.success && this.isActiveLoad(context) && this.deps.isCurrentTarget(project)) {
					await this.deps.refreshAfterMutation(project);
				}
			});
		});
	}

	async popStash(project: GitProjectTarget, stashRef: string): Promise<void> {
		if (!this.deps.isCurrentTarget(project) || !this.deps.ensureFreshForGitMutation()) return;
		await this.withLoading('Failed to pop stash', async (context) => {
			await this.deps.runGitMutation(project, async () => {
				const result = await gitPopStash(project, stashRef);
				if (result.success && this.isActiveLoad(context) && this.deps.isCurrentTarget(project)) {
					await this.loadStashes(project, context);
					if (!this.isActiveLoad(context)) return;
					await this.deps.refreshAfterMutation(project);
				}
			});
		});
	}

	async dropStash(project: GitProjectTarget, stashRef: string): Promise<void> {
		if (!this.deps.isCurrentTarget(project) || !this.deps.ensureFreshForGitMutation()) return;
		await this.withLoading('Failed to drop stash', async (context) => {
			await this.deps.runGitMutation(project, async () => {
				const result = await gitDropStash(project, stashRef);
				if (result.success && this.isActiveLoad(context) && this.deps.isCurrentTarget(project)) {
					await this.loadStashes(project, context);
				}
			});
		});
	}

	async loadHistory(
		project: GitProjectTarget,
		context: PorcelainLoadContext = this.beginTrackedLoad(),
	): Promise<void> {
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
					getGitFileHistory(project, filePath, 50, { signal: context?.signal }),
					getGitBlame(project, filePath, 'HEAD', 300, { signal: context?.signal }),
				]);
				if (!this.isActiveLoad(context) || this.deps.selectedFile() !== filePath) return;
				this.fileHistory = history.commits;
				this.blameLines = blame.lines;
				this.blameTruncated = blame.truncated;
			},
			context,
		);
	}

	async loadGraph(
		project: GitProjectTarget,
		context: PorcelainLoadContext = this.beginTrackedLoad(),
	): Promise<void> {
		await this.withLoading(
			'Failed to load commit graph',
			async () => {
				const result = await getGitGraph(project, 200, { signal: context?.signal });
				if (!this.isActiveLoad(context)) return;
				this.graphCommits = result.commits;
			},
			context,
		);
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

	private isActiveLoad(context: PorcelainLoadContext): boolean {
		return this.activeLoadId === context.requestId && !context.signal.aborted;
	}

	private async withLoading(
		label: string,
		action: (context: PorcelainLoadContext) => Promise<void>,
		context: PorcelainLoadContext = this.beginTrackedLoad(),
	): Promise<void> {
		if (this.isActiveLoad(context)) this.isLoading = true;
		try {
			await action(context);
		} catch (error) {
			if (isAbortError(error)) return;
			if (this.isActiveLoad(context)) {
				this.deps.surfaceError(
					`${label}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} finally {
			if (this.isActiveLoad(context)) {
				this.isLoading = false;
				this.activeLoadAbort = null;
			}
		}
	}
}
