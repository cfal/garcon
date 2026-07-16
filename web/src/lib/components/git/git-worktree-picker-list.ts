export const WORKTREE_VIRTUALIZATION_THRESHOLD = 80;
export const WORKTREE_ROW_HEIGHT_WIDE = 60;
export const WORKTREE_ROW_HEIGHT_NARROW = 76;
export const WORKTREE_ROW_OVERSCAN = 6;
export const WORKTREE_LIST_DEFAULT_VIEWPORT_HEIGHT = 400;
export const WORKTREE_NARROW_MEDIA_QUERY = 'not all and (min-width: 40rem)';

export function worktreeOptionId(listboxId: string, worktreePath: string): string {
	return `${listboxId}-option-${encodeURIComponent(worktreePath)}`;
}
