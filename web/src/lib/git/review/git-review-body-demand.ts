interface GitReviewBodyDemandBase {
	documentId: string;
	filePaths: readonly string[];
}

export interface GitReviewViewportDemand extends GitReviewBodyDemandBase {
	kind: 'viewport';
}

export interface GitReviewNavigationDemand extends GitReviewBodyDemandBase {
	kind: 'navigation';
}

export type GitReviewBodyDemand = GitReviewViewportDemand | GitReviewNavigationDemand;

export type GitReviewDemandOutcome =
	'scheduled' | 'not-ready' | 'stale-document' | 'already-satisfied' | 'limited';

export function normalizeGitReviewDemandFilePaths(
	filePaths: readonly (string | null | undefined)[],
): string[] {
	return Array.from(new Set(filePaths.filter((path): path is string => Boolean(path))));
}

export function sameGitReviewViewportDemand(
	left: GitReviewViewportDemand | null,
	right: GitReviewViewportDemand,
): boolean {
	if (!left || left.documentId !== right.documentId) return false;
	if (left.filePaths.length !== right.filePaths.length) return false;
	return left.filePaths.every((path, index) => path === right.filePaths[index]);
}
