import type { GitDiffTab } from '$lib/api/git.js';

export type DiffMode = 'unified' | 'split';

export interface GitWorkbenchTarget {
	projectPath: string;
	repoRoot: string;
	worktreePath: string;
	label: string;
	branch?: string;
	source: 'chat-project' | 'repo-root' | 'worktree';
}

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
		| 'context-change';
	preserveDrafts?: boolean;
	preserveSelection?: boolean;
	preferSelectedFile?: boolean;
}

export type GitWorkbenchMutationRunner = <T>(
	projectPath: string,
	action: () => Promise<T>,
) => Promise<T>;

export interface GitWorkbenchDeps {
	getSettings: () => Promise<{
		ui?: Record<string, unknown>;
		uiEffective?: Record<string, unknown>;
	}>;
	remoteSnapshot?: () => {
		ui?: Record<string, unknown>;
		uiEffective?: Record<string, unknown>;
	} | null;
}

export interface CommitMessageSettings {
	commitGenerationEnabled: boolean;
}

export interface GitWorkbenchLoadGuard {
	generation: number;
	targetKey: string;
	projectPath: string;
	tab: GitDiffTab;
	contextLines: number;
}

export const DEFAULT_REFRESH_OPTIONS = {
	preserveDrafts: true,
	preserveSelection: true,
	preferSelectedFile: true,
};

export function targetKey(target: GitWorkbenchTarget | null): string {
	return target ? target.projectPath : '';
}
