import * as m from '$lib/paraglide/messages.js';
import { errorMessage } from '$lib/utils/error-message.js';
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
	type GitStashTarget,
} from '$lib/api/git.js';
import { ApiError } from '$lib/api/client.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import type { GitWorkbenchMutationRunner } from '$lib/git/workbench/git-workbench-types.js';

export type GitInspectorView = 'none' | 'conflicts' | 'stash' | 'history' | 'graph';

const BLAME_PREVIEW_LINES = 12;

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
	conflicts = $state.raw<GitConflictFile[]>([]);
	conflictDetails = $state<GitConflictDetails | null>(null);
	stashes = $state.raw<GitStashEntry[]>([]);
	fileHistory = $state.raw<GitFileHistoryEntry[]>([]);
	blameLines = $state.raw<GitBlameLine[]>([]);
	blameTruncated = $state(false);
	graphCommits = $state.raw<GitGraphCommit[]>([]);
	stashMessage = $state('');
	stashIncludeUntracked = $state(false);
	private activeLoadId = $state(0);
	private activeLoadAbort: AbortController | null = null;

	constructor(private readonly deps: GitPorcelainDeps) {}

	get confirmationScope(): number {
		return this.activeLoadId;
	}

	setInspectorView(view: GitInspectorView): void {
		this.inspectorView = this.inspectorView === view ? 'none' : view;
	}

	closeInspector(): void {
		this.inspectorView = 'none';
	}

	async loadCurrentView(project: GitProjectTarget): Promise<void> {
		if (this.inspectorView === 'conflicts') await this.loadConflicts(project);
		else if (this.inspectorView === 'stash') await this.loadStashes(project);
		else if (this.inspectorView === 'history') await this.loadHistory(project);
		else if (this.inspectorView === 'graph') await this.loadGraph(project);
		else this.cancelActiveLoad();
	}

	cancelActiveLoad(): void {
		this.activeLoadAbort?.abort();
		this.activeLoadAbort = null;
		this.activeLoadId += 1;
		this.isLoading = false;
	}

	async loadConflicts(project: GitProjectTarget, parent?: PorcelainLoadContext): Promise<void> {
		await this.withLoading(
			m.git_porcelain_load_conflicts_failed,
			async (context) => {
				this.conflicts = [];
				this.conflictDetails = null;
				const result = await getGitConflicts(project, { signal: context.signal });
				if (!this.isActiveLoad(context)) return;
				const conflicts = result.conflicts;
				let details: GitConflictDetails | null = null;
				if (conflicts.length > 0) {
					details = await getGitConflictDetails(project, conflicts[0].path, {
						signal: context.signal,
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
			parent,
		);
	}

	async selectConflict(project: GitProjectTarget, filePath: string): Promise<void> {
		await this.withLoading(m.git_porcelain_load_conflict_details_failed, async (context) => {
			this.conflictDetails = null;
			const details = await getGitConflictDetails(project, filePath, { signal: context.signal });
			if (this.isActiveLoad(context)) this.conflictDetails = details;
		});
	}

	async acceptConflictSide(
		project: GitProjectTarget,
		filePath: string,
		side: 'ours' | 'theirs',
	): Promise<void> {
		if (!this.canMutateConflict(project, filePath)) return;
		await this.withLoading(m.git_porcelain_accept_conflict_side_failed, async (context) => {
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
		if (!this.canMutateConflict(project, filePath)) return;
		await this.withLoading(m.git_porcelain_mark_conflict_resolved_failed, async (context) => {
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

	private canMutateConflict(project: GitProjectTarget, path: string): boolean {
		return !this.isLoading && this.conflictDetails?.path === path &&
			this.deps.isCurrentTarget(project) && this.deps.ensureFreshForGitMutation();
	}

	async loadStashes(project: GitProjectTarget, parent?: PorcelainLoadContext): Promise<void> {
		await this.withLoading(
			m.git_porcelain_load_stashes_failed,
			async (context) => {
				const result = await getGitStashes(project, { signal: context.signal });
				if (!this.isActiveLoad(context)) return;
				this.stashes = result.stashes;
			},
			parent,
		);
	}

	async createStash(project: GitProjectTarget): Promise<void> {
		if (!this.deps.isCurrentTarget(project) || !this.deps.ensureFreshForGitMutation()) return;
		await this.withLoading(m.git_porcelain_create_stash_failed, async (context) => {
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

	async applyStash(project: GitProjectTarget, stash: GitStashTarget): Promise<void> {
		const target = { ref: stash.ref, hash: stash.hash };
		if (!this.deps.isCurrentTarget(project) || !this.deps.ensureFreshForGitMutation()) return;
		await this.withLoading(m.git_porcelain_apply_stash_failed, async (context) => {
			await this.deps.runGitMutation(project, async () => {
				const result = await this.submitStashAction(project, context, () =>
					gitApplyStash(project, target),
				);
				if (result.success && this.isActiveLoad(context) && this.deps.isCurrentTarget(project)) {
					await this.deps.refreshAfterMutation(project);
				}
			});
		});
	}

	async popStash(project: GitProjectTarget, stash: GitStashTarget): Promise<void> {
		const target = { ref: stash.ref, hash: stash.hash };
		if (!this.deps.isCurrentTarget(project) || !this.deps.ensureFreshForGitMutation()) return;
		await this.withLoading(m.git_porcelain_pop_stash_failed, async (context) => {
			await this.deps.runGitMutation(project, async () => {
				const result = await this.submitStashAction(project, context, () =>
					gitPopStash(project, target),
				);
				if (result.success && this.isActiveLoad(context) && this.deps.isCurrentTarget(project)) {
					await this.loadStashes(project, context);
					if (!this.isActiveLoad(context)) return;
					await this.deps.refreshAfterMutation(project);
				}
			});
		});
	}

	async dropStash(project: GitProjectTarget, stash: GitStashTarget): Promise<void> {
		const target = { ref: stash.ref, hash: stash.hash };
		if (!this.deps.isCurrentTarget(project) || !this.deps.ensureFreshForGitMutation()) return;
		await this.withLoading(m.git_porcelain_drop_stash_failed, async (context) => {
			await this.deps.runGitMutation(project, async () => {
				const result = await this.submitStashAction(project, context, () =>
					gitDropStash(project, target),
				);
				if (result.success && this.isActiveLoad(context) && this.deps.isCurrentTarget(project)) {
					await this.loadStashes(project, context);
				}
			});
		});
	}

	// A selection from an outdated listing reloads the list and still fails, so the user chooses
	// again rather than the action being retried against whichever stash now holds the selector.
	private async submitStashAction<T>(
		project: GitProjectTarget,
		context: PorcelainLoadContext,
		submit: () => Promise<T>,
	): Promise<T> {
		try {
			return await submit();
		} catch (error) {
			if (
				error instanceof ApiError &&
				error.errorCode === 'GIT_STALE_STASH' &&
				this.isActiveLoad(context) &&
				this.deps.isCurrentTarget(project)
			) {
				await this.loadStashes(project, context);
			}
			throw error;
		}
	}

	private async loadHistory(project: GitProjectTarget): Promise<void> {
		const filePath = this.deps.selectedFile();
		await this.withLoading(m.git_porcelain_load_file_history_failed, async (context) => {
			const { signal } = context;
			if (!filePath) {
				this.fileHistory = [];
				this.blameLines = [];
				this.blameTruncated = false;
				return;
			}
			const [history, blame] = await Promise.all([
				getGitFileHistory(project, filePath, 8, { signal }),
				getGitBlame(project, filePath, 'HEAD', BLAME_PREVIEW_LINES + 1, { signal }),
			]);
			if (!this.isActiveLoad(context) || this.deps.selectedFile() !== filePath) return;
			this.fileHistory = history.commits;
			this.blameLines = blame.lines.slice(0, BLAME_PREVIEW_LINES);
			this.blameTruncated = blame.truncated || blame.lines.length > BLAME_PREVIEW_LINES;
		});
	}

	private async loadGraph(project: GitProjectTarget): Promise<void> {
		await this.withLoading(m.git_porcelain_load_commit_graph_failed, async (context) => {
			const result = await getGitGraph(project, 30, { signal: context.signal });
			if (this.isActiveLoad(context)) this.graphCommits = result.commits;
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
		describeError: (inputs: { detail: string }) => string,
		action: (context: PorcelainLoadContext) => Promise<void>,
		parent?: PorcelainLoadContext,
	): Promise<void> {
		const context = parent ?? this.beginTrackedLoad();
		if (!this.isActiveLoad(context)) return;
		if (!parent) this.isLoading = true;
		try {
			await action(context);
		} catch (error) {
			if (isAbortError(error)) return;
			if (this.isActiveLoad(context)) {
				this.deps.surfaceError(
					describeError({ detail: errorMessage(error) }),
				);
			}
		} finally {
			if (!parent && this.isActiveLoad(context)) {
				this.isLoading = false;
				this.activeLoadAbort = null;
			}
		}
	}
}
