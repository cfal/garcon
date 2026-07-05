import {
	getGitWorktrees,
	gitCreateWorktree,
	gitRemoveWorktree,
	type GitWorktreeItem,
} from '$lib/api/git.js';
import * as m from '$lib/paraglide/messages.js';

export interface GitWorktreesDeps {
	surfaceError: (message: string) => void;
}

export class GitWorktrees {
	worktrees = $state<GitWorktreeItem[]>([]);
	isLoadingWorktrees = $state(false);

	constructor(private readonly deps: GitWorktreesDeps) {}

	async loadWorktrees(projectPath: string): Promise<void> {
		this.isLoadingWorktrees = true;
		try {
			const data = await getGitWorktrees(projectPath);
			this.worktrees = data.worktrees;
		} catch (error) {
			this.deps.surfaceError(
				m.git_worktrees_load_failed({
					detail: error instanceof Error ? error.message : String(error),
				}),
			);
			this.worktrees = [];
		} finally {
			this.isLoadingWorktrees = false;
		}
	}

	async createWorktree(
		projectPath: string,
		worktreePath: string,
		options: { baseRef?: string; branch?: string; detach?: boolean } = {},
	): Promise<boolean> {
		try {
			const result = await gitCreateWorktree(projectPath, worktreePath, options);
			if (result.success) await this.loadWorktrees(projectPath);
			return result.success ?? false;
		} catch (error) {
			this.deps.surfaceError(
				m.git_worktrees_create_failed({
					detail: error instanceof Error ? error.message : String(error),
				}),
			);
			return false;
		}
	}

	async removeWorktree(projectPath: string, worktreePath: string, force = false): Promise<boolean> {
		try {
			const result = await gitRemoveWorktree(projectPath, worktreePath, force);
			if (result.success) await this.loadWorktrees(projectPath);
			return result.success ?? false;
		} catch (error) {
			this.deps.surfaceError(
				m.git_worktrees_remove_failed({
					detail: error instanceof Error ? error.message : String(error),
				}),
			);
			return false;
		}
	}

	reset(): void {
		this.worktrees = [];
		this.isLoadingWorktrees = false;
	}
}
