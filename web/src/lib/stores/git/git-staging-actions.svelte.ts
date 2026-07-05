import {
	gitDeleteUntracked,
	gitDiscard,
	gitStagePaths,
	gitStageHunk,
	gitStageSelection,
	type GitDiffTab,
	type GitTreeNode,
} from '$lib/api/git.js';
import type {
	GitDiffActionMode,
	GitDiffActionTarget,
	GitWorkbenchMutationRunner,
	GitWorkbenchRefreshOptions,
} from './git-workbench-types';
import type { GitLineSelectionState } from './git-line-selection.svelte';

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
	refreshAllData: () => void;
	refreshFileAfterStage: (projectPath: string, filePath: string) => Promise<void>;
	refreshAfterGitAction: (
		projectPath: string,
		options: GitWorkbenchRefreshOptions,
	) => Promise<void>;
	surfaceError: (message: string) => void;
	ensureFreshForGitMutation: () => boolean;
	runGitMutation: GitWorkbenchMutationRunner;
}

export class GitStagingActions {
	pendingDiscardFile = $state<string | null>(null);
	pendingOperationKeys = $state(new Set<GitOperationKey>());

	constructor(private readonly deps: GitStagingActionsDeps) {}

	async stageSelectedLines(projectPath: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageGroupedSelectedLines(projectPath, 'stage');
	}

	async unstageSelectedLines(projectPath: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageGroupedSelectedLines(projectPath, 'unstage');
	}

	async stageLine(
		projectPath: string,
		target: GitDiffActionTarget,
		diffLineIndex: number,
	): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageSelectionForTarget(projectPath, { ...target, mode: 'stage' }, [diffLineIndex]);
	}

	async unstageLine(
		projectPath: string,
		target: GitDiffActionTarget,
		diffLineIndex: number,
	): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageSelectionForTarget(projectPath, { ...target, mode: 'unstage' }, [
			diffLineIndex,
		]);
	}

	async stageHunk(
		projectPath: string,
		targetOrHunkIndex: GitDiffActionTarget | number,
		maybeHunkIndex?: number,
	): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		const target =
			typeof targetOrHunkIndex === 'number'
				? this.targetForSelectedFile('stage')
				: { ...targetOrHunkIndex, mode: 'stage' as const };
		const hunkIndex = typeof targetOrHunkIndex === 'number' ? targetOrHunkIndex : maybeHunkIndex;
		if (!target || hunkIndex === undefined) return false;
		return this.withPendingGitMutation(
			projectPath,
			this.operationKeyForHunk(target.filePath, 'stage', hunkIndex),
			async () => {
				const result = await gitStageHunk(
					projectPath,
					target.filePath,
					'stage',
					hunkIndex,
					target.contextLines,
				);
				if (result.success) {
					await this.deps.refreshFileAfterStage(projectPath, target.filePath);
				}
				return result.success ?? false;
			},
			'Stage hunk failed',
		);
	}

	async unstageHunk(
		projectPath: string,
		targetOrHunkIndex: GitDiffActionTarget | number,
		maybeHunkIndex?: number,
	): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		const target =
			typeof targetOrHunkIndex === 'number'
				? this.targetForSelectedFile('unstage')
				: { ...targetOrHunkIndex, mode: 'unstage' as const };
		const hunkIndex = typeof targetOrHunkIndex === 'number' ? targetOrHunkIndex : maybeHunkIndex;
		if (!target || hunkIndex === undefined) return false;
		return this.withPendingGitMutation(
			projectPath,
			this.operationKeyForHunk(target.filePath, 'unstage', hunkIndex),
			async () => {
				const result = await gitStageHunk(
					projectPath,
					target.filePath,
					'unstage',
					hunkIndex,
					target.contextLines,
				);
				if (result.success) {
					await this.deps.refreshFileAfterStage(projectPath, target.filePath);
				}
				return result.success ?? false;
			},
			'Unstage hunk failed',
		);
	}

	async stageFile(projectPath: string, filePath: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageFileWithMode(projectPath, filePath, 'stage', 'Stage file failed');
	}

	async unstageFile(projectPath: string, filePath: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageFileWithMode(projectPath, filePath, 'unstage', 'Unstage file failed');
	}

	async stageDirectory(projectPath: string, dirPath: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageDirectoryWithMode(projectPath, dirPath, 'stage', 'Stage directory failed');
	}

	async unstageDirectory(projectPath: string, dirPath: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		return this.stageDirectoryWithMode(projectPath, dirPath, 'unstage', 'Unstage directory failed');
	}

	requestDiscard(filePath: string): void {
		if (!this.deps.ensureFreshForGitMutation()) return;
		this.pendingDiscardFile = filePath;
	}

	cancelDiscard(): void {
		this.pendingDiscardFile = null;
	}

	async confirmDiscard(projectPath: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		const filePath = this.pendingDiscardFile;
		if (!filePath) return false;
		this.pendingDiscardFile = null;
		return this.withPendingGitMutation(
			projectPath,
			`discard-file:${filePath}`,
			async () => {
				const node = this.deps.findTreeNode(filePath);
				const isUntracked = node?.changeKind === 'untracked';
				const result = isUntracked
					? await gitDeleteUntracked(projectPath, filePath)
					: await gitDiscard(projectPath, filePath);
				if (result.success) {
					this.deps.refreshAllData();
					await this.deps.refreshAfterGitAction(projectPath, { reason: 'git-action' });
					const visibleFilePaths = this.deps.visibleFilePaths();
					if (this.deps.selectedFile() === filePath && !visibleFilePaths.includes(filePath)) {
						this.deps.setSelectedFile(visibleFilePaths[0] ?? null);
					}
				}
				return result.success ?? false;
			},
			'Discard failed',
		);
	}

	reset(): void {
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
		projectPath: string,
		mode: GitDiffActionMode,
	): Promise<boolean> {
		const groups = this.deps.lineSelection.groupSelectedLineIndicesByTarget(
			mode,
			this.deps.contextLines(),
		);
		if (groups.length === 0) return false;
		const results = [];
		for (const group of groups) {
			results.push(
				await this.stageSelectionForTarget(projectPath, group.target, group.lineIndices),
			);
		}
		return results.every(Boolean);
	}

	private async stageSelectionForTarget(
		projectPath: string,
		target: GitDiffActionTarget,
		lineIndices: number[],
	): Promise<boolean> {
		const key = this.operationKeyForLines(target.filePath, target.mode, lineIndices);
		return this.withPendingGitMutation(
			projectPath,
			key,
			async () => {
				const result = await gitStageSelection(
					projectPath,
					target.filePath,
					target.mode,
					lineIndices,
					target.contextLines,
				);
				if (result.success) {
					this.deps.lineSelection.clearSelectionForFile(target.filePath, target.tab);
					await this.deps.refreshFileAfterStage(projectPath, target.filePath);
				}
				return result.success ?? false;
			},
			`${target.mode === 'stage' ? 'Stage' : 'Unstage'} failed`,
		);
	}

	private targetForSelectedFile(mode: GitDiffActionMode): GitDiffActionTarget | null {
		const selectedFile = this.deps.selectedFile();
		if (!selectedFile) return null;
		return {
			filePath: selectedFile,
			tab: this.deps.activeTab(),
			mode,
			contextLines: this.deps.contextLines(),
		};
	}

	private async stageFileWithMode(
		projectPath: string,
		filePath: string,
		mode: GitDiffActionMode,
		failurePrefix: string,
	): Promise<boolean> {
		return this.withPendingGitMutation(
			projectPath,
			this.operationKeyForFile(filePath, mode),
			async () => {
				const result = await gitStagePaths(projectPath, [filePath], mode);
				if (result.success) {
					await this.deps.refreshFileAfterStage(projectPath, filePath);
				}
				return result.success ?? false;
			},
			failurePrefix,
		);
	}

	private async stageDirectoryWithMode(
		projectPath: string,
		dirPath: string,
		mode: GitDiffActionMode,
		failurePrefix: string,
	): Promise<boolean> {
		return this.withPendingGitMutation(
			projectPath,
			this.operationKeyForDirectory(dirPath, mode),
			async () => {
				const result = await gitStagePaths(projectPath, [dirPath], mode);
				if (result.success) {
					this.deps.refreshAllData();
					await this.deps.refreshAfterGitAction(projectPath, { reason: 'git-action' });
				}
				return result.success ?? false;
			},
			failurePrefix,
		);
	}

	private async withPendingGitMutation(
		projectPath: string,
		key: GitOperationKey,
		action: () => Promise<boolean>,
		failurePrefix: string,
	): Promise<boolean> {
		return this.withPending(
			key,
			() => this.deps.runGitMutation(projectPath, action),
			failurePrefix,
		);
	}

	private async withPending(
		key: GitOperationKey,
		action: () => Promise<boolean>,
		failurePrefix: string,
	): Promise<boolean> {
		if (this.pendingOperationKeys.has(key)) return false;
		this.pendingOperationKeys = new Set([...this.pendingOperationKeys, key]);
		try {
			return await action();
		} catch (error) {
			this.deps.surfaceError(
				`${failurePrefix}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		} finally {
			const next = new Set(this.pendingOperationKeys);
			next.delete(key);
			this.pendingOperationKeys = next;
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
