// Derives conventional worktree paths from branch names.

/** Sanitizes a branch name into a filesystem-safe directory name. */
export function sanitizeBranchForPath(branch: string): string {
	return branch
		.trim()
		.replace(/[/\\]/g, '-')
		.replace(/[^a-zA-Z0-9._-]/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-|-$/g, '')
		.replace(/^\.+$/, '');
}

/** Derives a worktree path from a branch name using the ../.worktrees/ convention. */
export function deriveWorktreePath(branch: string): string {
	const dir = sanitizeBranchForPath(branch);
	if (!dir) return '';
	return `../.worktrees/${dir}`;
}
