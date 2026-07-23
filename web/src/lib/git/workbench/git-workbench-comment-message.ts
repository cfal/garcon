import {
	formatGitReviewCommentContext,
	formatGitReviewInlineCode,
} from '$lib/git/review/git-review-comment-context.js';

export interface GitWorkbenchCommentMessageInput {
	filePath: string;
	originalPath?: string;
	tab: 'staged' | 'unstaged';
	side: 'before' | 'after';
	line: number;
	contextLines: string[];
	body: string;
	severity: 'note' | 'warning' | 'blocker';
}

export function buildGitWorkbenchCommentMessage(input: GitWorkbenchCommentMessageInput): string {
	const path = input.originalPath
		? `${input.originalPath} -> ${input.filePath}`
		: input.filePath;
	const severity = input.severity === 'note' ? [] : [`Severity: ${input.severity}`];
	const context = formatGitReviewCommentContext(input.contextLines);
	return [
		'Git review comment',
		`Comparison: current ${input.tab} changes`,
		`Location: ${formatGitReviewInlineCode(path)}:${input.line} (${input.side === 'before' ? 'old line' : 'new line'})`,
		...severity,
		...context,
		'',
		'Comment:',
		input.body.trim(),
	].join('\n');
}
