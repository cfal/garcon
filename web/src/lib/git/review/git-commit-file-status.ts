import type { GitCommitFileSummary, GitStatusCode } from '$lib/api/git.js';

export function statusToIndexStatus(status: GitCommitFileSummary['status']): GitStatusCode {
	switch (status) {
		case 'added':
			return 'A';
		case 'deleted':
			return 'D';
		case 'renamed':
			return 'R';
		case 'copied':
			return 'C';
		case 'type-changed':
			return 'T';
		case 'modified':
			return 'M';
		default:
			return '?';
	}
}
