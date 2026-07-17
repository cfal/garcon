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

/** Derives a worktree path inside the repository's .worktrees directory. */
export function deriveWorktreePath(repositoryRoot: string, branch: string): string {
	const dir = sanitizeBranchForPath(branch);
	const root = repositoryRoot.trim();
	if (!root || !dir) return '';

	const separator = root.includes('\\') ? '\\' : '/';
	const rootWithoutTrailingSeparators = root.replace(/[\\/]+$/, '');
	const base = rootWithoutTrailingSeparators || separator;
	const joiner = base.endsWith(separator) ? '' : separator;
	return `${base}${joiner}.worktrees${separator}${dir}`;
}
