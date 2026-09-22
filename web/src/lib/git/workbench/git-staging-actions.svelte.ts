import type { GitProjectTarget } from '$lib/api/git-client.js';
import {
	gitDeleteUntracked,
	gitDiscard,
	gitStagePaths,
	gitStageHunk,
	gitStageSelection,
	type GitDiffTab,
	type GitTreeNode,
} from '$lib/api/git.js';
import * as m from '$lib/paraglide/messages.js';
import type {
	GitDiffActionMode,
	GitDiffActionTarget,
	GitWorkbenchMutationRunner,
	GitWorkbenchRefreshOptions,
} from '$lib/git/workbench/git-workbench-types.js';
import type { GitLineSelectionState } from '$lib/git/review/git-line-selection.svelte.js';

export type GitOperationKey =
	| `stage-file:${string}`
	| `unstage-file:${string}`
	| `stage-dir:${string}`
	| `unstage-dir:${string}`
	| `stage-hunk:${string}:${number}`
	| `unstage-hunk:${string}:${number}`
	| `stage-lines:${string}:${string}`
	| `unstage-lines:${string}:${string}`
	| `discard-file:${string}`;

export interface GitStagingActionsDeps {
	selectedFile: () => string | null;
	activeTab: () => GitDiffTab;
	contextLines: () => number;
	visibleFilePaths: () => string[];
	lineSelection: GitLineSelectionState;
	findTreeNode: (filePath: string) => GitTreeNode | undefined;
	setSelectedFile: (filePath: string | null) => void;
	invalidateReviewData: (project: GitProjectTarget) => void;
	refreshFileAfterStage: (project: GitProjectTarget, filePath: string) => Promise<void>;
	refreshAfterGitAction: (
		project: GitProjectTarget,
		options: GitWorkbenchRefreshOptions,
	) => Promise<void>;
	surfaceError: (message: string) => void;
	ensureFreshForGitMutation: () => boolean;
	isCurrentTarget: (project: GitProjectTarget) => boolean;
	runGitMutation: GitWorkbenchMutationRunner;
}

export class GitStagingActions {
	private generation = 0;
	pendingDiscardFile = $state<string | null>(null);
	pendingOperationKeys = $state(new Set<GitOperationKey>());

	constructor(private readonly deps: GitStagingActionsDeps) {}

	async stageSelectedLines(project: GitProjectTarget): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageGroupedSelectedLines(project, 'stage');
	}

	async unstageSelectedLines(project: GitProjectTarget): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageGroupedSelectedLines(project, 'unstage');
	}

	async stageLine(
		project: GitProjectTarget,
		target: GitDiffActionTarget,
		diffLineIndex: number,
	): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageSelectionForTarget(project, { ...target, mode: 'stage' }, [diffLineIndex]);
	}

	async unstageLine(
		project: GitProjectTarget,
		target: GitDiffActionTarget,
		diffLineIndex: number,
	): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageSelectionForTarget(project, { ...target, mode: 'unstage' }, [diffLineIndex]);
	}

	async stageHunk(
		project: GitProjectTarget,
		target: GitDiffActionTarget,
		hunkIndex: number,
	): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.withPendingGitMutation(
			project,
			this.operationKeyForHunk(target.filePath, 'stage', hunkIndex),
			async () => {
				const result = await gitStageHunk(
					project,
					target.filePath,
					'stage',
					hunkIndex,
					target.contextLines,
					target.proof,
				);
				if (result.success && this.deps.isCurrentTarget(project)) {
					await this.deps.refreshFileAfterStage(project, target.filePath);
				}
				return result.success ?? false;
			},
			m.git_action_stage_hunk_failed(),
		);
	}

	async unstageHunk(
		project: GitProjectTarget,
		target: GitDiffActionTarget,
		hunkIndex: number,
	): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.withPendingGitMutation(
			project,
			this.operationKeyForHunk(target.filePath, 'unstage', hunkIndex),
			async () => {
				const result = await gitStageHunk(
					project,
					target.filePath,
					'unstage',
					hunkIndex,
					target.contextLines,
					target.proof,
				);
				if (result.success && this.deps.isCurrentTarget(project)) {
					await this.deps.refreshFileAfterStage(project, target.filePath);
				}
				return result.success ?? false;
			},
			m.git_action_unstage_hunk_failed(),
		);
	}

	async stageFile(project: GitProjectTarget, filePath: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageFileWithMode(project, filePath, 'stage', m.git_action_stage_file_failed());
	}

	async unstageFile(project: GitProjectTarget, filePath: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageFileWithMode(project, filePath, 'unstage', m.git_action_unstage_file_failed());
	}

	async stageDirectory(project: GitProjectTarget, dirPath: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageDirectoryWithMode(
			project,
			dirPath,
			'stage',
			m.git_action_stage_directory_failed(),
		);
	}

	async unstageDirectory(project: GitProjectTarget, dirPath: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageDirectoryWithMode(
			project,
			dirPath,
			'unstage',
			m.git_action_unstage_directory_failed(),
		);
	}

	requestDiscard(filePath: string): void {
		if (!this.deps.ensureFreshForGitMutation()) return;
		this.pendingDiscardFile = filePath;
	}

	cancelDiscard(): void {
		this.pendingDiscardFile = null;
	}

	async confirmDiscard(project: GitProjectTarget): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		const filePath = this.pendingDiscardFile;
		if (!filePath) return false;
		this.pendingDiscardFile = null;
		return this.withPendingGitMutation(
			project,
			`discard-file:${filePath}`,
			async () => {
				const node = this.deps.findTreeNode(filePath);
				const isUntracked = node?.changeKind === 'untracked';
				const result = isUntracked
					? await gitDeleteUntracked(project, filePath)
					: await gitDiscard(project, filePath);
				if (result.success && this.deps.isCurrentTarget(project)) {
					this.deps.invalidateReviewData(project);
					await this.deps.refreshAfterGitAction(project, { reason: 'git-action' });
					const visibleFilePaths = this.deps.visibleFilePaths();
					if (this.deps.selectedFile() === filePath && !visibleFilePaths.includes(filePath)) {
						this.deps.setSelectedFile(visibleFilePaths[0] ?? null);
					}
				}
				return result.success ?? false;
			},
			m.git_action_discard_failed(),
		);
	}

	reset(): void {
		this.generation++;
		this.pendingDiscardFile = null;
		this.pendingOperationKeys = new Set();
	}

	isPending(key: GitOperationKey): boolean {
		return this.pendingOperationKeys.has(key);
	}

	get hasPendingOperations(): boolean {
		return this.pendingOperationKeys.size > 0;
	}

	isFilePending(filePath: string, mode: GitDiffActionMode): boolean {
		return this.isPending(this.operationKeyForFile(filePath, mode));
	}

	isDirectoryPending(dirPath: string, mode: GitDiffActionMode): boolean {
		return this.isPending(this.operationKeyForDirectory(dirPath, mode));
	}

	private async stageGroupedSelectedLines(
		project: GitProjectTarget,
		mode: GitDiffActionMode,
	): Promise<boolean> {
		const groups = this.deps.lineSelection.groupSelectedLineIndicesByTarget(mode);
		if (groups.length === 0) return false;
		const results = [];
		for (const group of groups) {
			if (!this.deps.isCurrentTarget(project) || !this.deps.ensureFreshForGitMutation())
				return false;
			results.push(await this.stageSelectionForTarget(project, group.target, group.lineIndices));
		}
		return results.every(Boolean);
	}

	private async stageSelectionForTarget(
		project: GitProjectTarget,
		target: GitDiffActionTarget,
		lineIndices: number[],
	): Promise<boolean> {
		const key = this.operationKeyForLines(target.filePath, target.mode, lineIndices);
		return this.withPendingGitMutation(
			project,
			key,
			async () => {
				const result = await gitStageSelection(
					project,
					target.filePath,
					target.mode,
					lineIndices,
					target.contextLines,
					target.proof,
				);
				if (result.success && this.deps.isCurrentTarget(project)) {
					this.deps.lineSelection.clearSelectionForFile(target.filePath, target.tab);
					await this.deps.refreshFileAfterStage(project, target.filePath);
				}
				return result.success ?? false;
			},
			target.mode === 'stage'
				? m.git_action_stage_selection_failed()
				: m.git_action_unstage_selection_failed(),
		);
	}

	private async stageFileWithMode(
		project: GitProjectTarget,
		filePath: string,
		mode: GitDiffActionMode,
		failurePrefix: string,
	): Promise<boolean> {
		return this.withPendingGitMutation(
			project,
			this.operationKeyForFile(filePath, mode),
			async () => {
				const result = await gitStagePaths(project, [filePath], mode);
				if (result.success && this.deps.isCurrentTarget(project)) {
					await this.deps.refreshFileAfterStage(project, filePath);
				}
				return result.success ?? false;
			},
			failurePrefix,
		);
	}

	private async stageDirectoryWithMode(
		project: GitProjectTarget,
		dirPath: string,
		mode: GitDiffActionMode,
		failurePrefix: string,
	): Promise<boolean> {
		return this.withPendingGitMutation(
			project,
			this.operationKeyForDirectory(dirPath, mode),
			async () => {
				const result = await gitStagePaths(project, [dirPath], mode);
				if (result.success && this.deps.isCurrentTarget(project)) {
					this.deps.invalidateReviewData(project);
					await this.deps.refreshAfterGitAction(project, { reason: 'git-action' });
				}
				return result.success ?? false;
			},
			failurePrefix,
		);
	}

	private async withPendingGitMutation(
		project: GitProjectTarget,
		key: GitOperationKey,
		action: () => Promise<boolean>,
		failurePrefix: string,
	): Promise<boolean> {
		if (!this.deps.isCurrentTarget(project) || !this.deps.ensureFreshForGitMutation()) return false;
		return this.withPending(key, () => this.deps.runGitMutation(project, action), failurePrefix);
	}

	private async withPending(
		key: GitOperationKey,
		action: () => Promise<boolean>,
		failurePrefix: string,
	): Promise<boolean> {
		if (this.pendingOperationKeys.has(key)) return false;
		const generation = this.generation;
		this.pendingOperationKeys = new Set([...this.pendingOperationKeys, key]);
		try {
			return await action();
		} catch (error) {
			if (generation !== this.generation) return false;
			this.deps.surfaceError(
				m.git_action_failed_with_detail({
					summary: failurePrefix,
					detail: error instanceof Error ? error.message : String(error),
				}),
			);
			return false;
		} finally {
			if (generation === this.generation) {
				const next = new Set(this.pendingOperationKeys);
				next.delete(key);
				this.pendingOperationKeys = next;
			}
		}
	}

	private operationKeyForFile(filePath: string, mode: GitDiffActionMode): GitOperationKey {
		return `${mode}-file:${filePath}`;
	}

	private operationKeyForDirectory(dirPath: string, mode: GitDiffActionMode): GitOperationKey {
		return `${mode}-dir:${dirPath}`;
	}

	private operationKeyForHunk(
		filePath: string,
		mode: GitDiffActionMode,
		hunkIndex: number,
	): GitOperationKey {
		return `${mode}-hunk:${filePath}:${hunkIndex}`;
	}

	private operationKeyForLines(
		filePath: string,
		mode: GitDiffActionMode,
		lineIndices: number[],
	): GitOperationKey {
		return `${mode}-lines:${filePath}:${[...lineIndices].sort((a, b) => a - b).join(',')}`;
	}
}
