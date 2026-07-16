export const WORKTREE_VIRTUALIZATION_THRESHOLD = 80;
export const WORKTREE_ROW_HEIGHT = 68;
export const WORKTREE_ROW_OVERSCAN = 6;
export const WORKTREE_LIST_DEFAULT_VIEWPORT_HEIGHT = 400;

export function worktreeOptionId(listboxId: string, worktreePath: string): string {
	return `${listboxId}-option-${encodeURIComponent(worktreePath)}`;
}
