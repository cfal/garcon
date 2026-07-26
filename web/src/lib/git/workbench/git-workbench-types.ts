import type { GitDiffTab } from '$lib/api/git.js';
import type { GitTarget } from '$lib/git/targets/git-target.js';

export type DiffMode = 'unified' | 'split';

export type GitWorkbenchTarget = GitTarget;

export type GitDiffActionMode = 'stage' | 'unstage';

export interface GitDiffActionTarget {
	filePath: string;
	tab: GitDiffTab;
	mode: GitDiffActionMode;
	contextLines: number;
}

export interface GitLineSelectionKey {
	filePath: string;
	tab: GitDiffTab;
	side: 'before' | 'after';
	diffLineIndex: number;
}

export interface GitWorkbenchRefreshOptions {
	reason:
		| 'mount'
		| 'manual'
		| 'agent-event'
		| 'git-action'
		| 'branch-change'
		| 'worktree-change'
		| 'tab-change'
		| 'context-change'
		| 'document-expired';
	preserveSelection?: boolean;
	preferSelectedFile?: boolean;
}

export type GitWorkbenchMutationRunner = <T>(
	projectPath: string,
	action: () => Promise<T>,
) => Promise<T>;

export interface GitWorkbenchLoadGuard {
	generation: number;
	targetKey: string;
	projectPath: string;
	tab: GitDiffTab;
	contextLines: number;
}

export const DEFAULT_REFRESH_OPTIONS = {
	preserveSelection: true,
	preferSelectedFile: true,
};

export function targetKey(target: GitWorkbenchTarget | null): string {
	return target ? JSON.stringify([target.repoRoot, target.worktreePath]) : '';
}
