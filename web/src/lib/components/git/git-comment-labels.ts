import type { GitDiffSeverity } from '$lib/git/review/git-inline-comment.svelte.js';
import * as m from '$lib/paraglide/messages.js';

export function gitCommentSeverityLabel(severity: GitDiffSeverity): string {
	switch (severity) {
		case 'blocker':
			return m.git_comment_severity_blocker();
		case 'warning':
			return m.git_comment_severity_warning();
		default:
			return m.git_comment_severity_note();
	}
}
