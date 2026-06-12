import {
	gitDeleteUntracked,
	gitDiscard,
	gitStageFile,
	gitStageHunk,
	gitStageSelection,
	type GitDiffTab,
	type GitTreeNode,
} from '$lib/api/git.js';
import type {
	GitDiffActionMode,
	GitDiffActionTarget,
	GitWorkbenchRefreshOptions,
} from './git-workbench-types';
import type { GitLineSelectionState } from './git-line-selection.svelte';

export interface GitStagingActionsDeps {
	get selectedFile(): string | null;
	get activeTab(): GitDiffTab;
	get contextLines(): number;
	get visibleFilePaths(): string[];
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
}

export class GitStagingActions {
	pendingDiscardFile = $state<string | null>(null);

	constructor(private readonly deps: GitStagingActionsDeps) {}

	async stageSelectedLines(projectPath: string): Promise<boolean> {
		return this.stageGroupedSelectedLines(projectPath, 'stage');
	}

	async unstageSelectedLines(projectPath: string): Promise<boolean> {
		return this.stageGroupedSelectedLines(projectPath, 'unstage');
	}

	async stageLine(
		projectPath: string,
		target: GitDiffActionTarget,
		diffLineIndex: number,
	): Promise<boolean> {
		return this.stageSelectionForTarget(projectPath, { ...target, mode: 'stage' }, [diffLineIndex]);
	}

	async unstageLine(
		projectPath: string,
		target: GitDiffActionTarget,
		diffLineIndex: number,
	): Promise<boolean> {
		return this.stageSelectionForTarget(projectPath, { ...target, mode: 'unstage' }, [
			diffLineIndex,
		]);
	}

	async stageHunk(
		projectPath: string,
		targetOrHunkIndex: GitDiffActionTarget | number,
		maybeHunkIndex?: number,
	): Promise<boolean> {
		const target =
			typeof targetOrHunkIndex === 'number'
				? this.targetForSelectedFile('stage')
				: { ...targetOrHunkIndex, mode: 'stage' as const };
		const hunkIndex = typeof targetOrHunkIndex === 'number' ? targetOrHunkIndex : maybeHunkIndex;
		if (!target || hunkIndex === undefined) return false;
		try {
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
		} catch (error) {
			this.deps.surfaceError(
				`Stage hunk failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	async unstageHunk(
		projectPath: string,
		targetOrHunkIndex: GitDiffActionTarget | number,
		maybeHunkIndex?: number,
	): Promise<boolean> {
		const target =
			typeof targetOrHunkIndex === 'number'
				? this.targetForSelectedFile('unstage')
				: { ...targetOrHunkIndex, mode: 'unstage' as const };
		const hunkIndex = typeof targetOrHunkIndex === 'number' ? targetOrHunkIndex : maybeHunkIndex;
		if (!target || hunkIndex === undefined) return false;
		try {
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
		} catch (error) {
			this.deps.surfaceError(
				`Unstage hunk failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	async stageFile(projectPath: string, filePath: string): Promise<boolean> {
		return this.stageFileWithMode(projectPath, filePath, 'stage', 'Stage file failed');
	}

	async unstageFile(projectPath: string, filePath: string): Promise<boolean> {
		return this.stageFileWithMode(projectPath, filePath, 'unstage', 'Unstage file failed');
	}

	async stageDirectory(projectPath: string, dirPath: string): Promise<boolean> {
		return this.stageDirectoryWithMode(projectPath, dirPath, 'stage', 'Stage directory failed');
	}

	async unstageDirectory(projectPath: string, dirPath: string): Promise<boolean> {
		return this.stageDirectoryWithMode(projectPath, dirPath, 'unstage', 'Unstage directory failed');
	}

	requestDiscard(filePath: string): void {
		this.pendingDiscardFile = filePath;
	}

	cancelDiscard(): void {
		this.pendingDiscardFile = null;
	}

	async confirmDiscard(projectPath: string): Promise<boolean> {
		const filePath = this.pendingDiscardFile;
		if (!filePath) return false;
		this.pendingDiscardFile = null;
		try {
			const node = this.deps.findTreeNode(filePath);
			const isUntracked = node?.changeKind === 'untracked';
			const result = isUntracked
				? await gitDeleteUntracked(projectPath, filePath)
				: await gitDiscard(projectPath, filePath);
			if (result.success) {
				this.deps.refreshAllData();
				await this.deps.refreshAfterGitAction(projectPath, { reason: 'git-action' });
				if (this.deps.selectedFile === filePath && !this.deps.visibleFilePaths.includes(filePath)) {
					this.deps.setSelectedFile(this.deps.visibleFilePaths[0] ?? null);
				}
			}
			return result.success ?? false;
		} catch (error) {
			this.deps.surfaceError(
				`Discard failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	reset(): void {
		this.pendingDiscardFile = null;
	}

	private async stageGroupedSelectedLines(
		projectPath: string,
		mode: GitDiffActionMode,
	): Promise<boolean> {
		const groups = this.deps.lineSelection.groupSelectedLineIndicesByTarget(
			mode,
			this.deps.contextLines,
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
		try {
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
		} catch (error) {
			this.deps.surfaceError(
				`${target.mode === 'stage' ? 'Stage' : 'Unstage'} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	private targetForSelectedFile(mode: GitDiffActionMode): GitDiffActionTarget | null {
		if (!this.deps.selectedFile) return null;
		return {
			filePath: this.deps.selectedFile,
			tab: this.deps.activeTab,
			mode,
			contextLines: this.deps.contextLines,
		};
	}

	private async stageFileWithMode(
		projectPath: string,
		filePath: string,
		mode: GitDiffActionMode,
		failurePrefix: string,
	): Promise<boolean> {
		try {
			const result = await gitStageFile(projectPath, filePath, mode);
			if (result.success) {
				await this.deps.refreshFileAfterStage(projectPath, filePath);
			}
			return result.success ?? false;
		} catch (error) {
			this.deps.surfaceError(
				`${failurePrefix}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	private async stageDirectoryWithMode(
		projectPath: string,
		dirPath: string,
		mode: GitDiffActionMode,
		failurePrefix: string,
	): Promise<boolean> {
		try {
			const result = await gitStageFile(projectPath, dirPath, mode);
			if (result.success) {
				this.deps.refreshAllData();
				await this.deps.refreshAfterGitAction(projectPath, { reason: 'git-action' });
			}
			return result.success ?? false;
		} catch (error) {
			this.deps.surfaceError(
				`${failurePrefix}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}
}
