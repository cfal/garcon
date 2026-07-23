import type { GitComparisonMode } from '$lib/api/git-comparison.js';
import {
	formatGitReviewCommentContext,
	formatGitReviewInlineCode,
} from '$lib/git/review/git-review-comment-context.js';

export type GitReviewCommentSource =
	| {
			kind: 'commit';
			shortHash: string;
			subject: string;
			baseLabel: string;
	  }
	| {
			kind: 'comparison';
			fromLabel: string;
			fromIdentity: string;
			toLabel: string;
			toIdentity: string;
			mode: GitComparisonMode;
			mergeBaseHash?: string;
	  };

export interface GitReviewCommentMessageInput {
	source: GitReviewCommentSource;
	filePath: string;
	originalPath?: string;
	side: 'before' | 'after';
	line: number;
	contextLines: string[];
	body: string;
	severity: 'note' | 'warning' | 'blocker';
}

export function buildGitReviewCommentMessage(input: GitReviewCommentMessageInput): string {
	const source = input.source.kind === 'commit'
		? `${input.source.baseLabel} -> ${input.source.subject || 'commit'} (${input.source.shortHash})`
		: `${input.source.fromLabel} (${input.source.fromIdentity}) -> ${input.source.toLabel} (${input.source.toIdentity}), ${input.source.mode === 'merge-base' ? 'since common ancestor' : 'direct'}${input.source.mergeBaseHash ? `, merge base ${input.source.mergeBaseHash.slice(0, 10)}` : ''}`;
	const path = input.originalPath
		? `${input.originalPath} -> ${input.filePath}`
		: input.filePath;
	const severity = input.severity === 'note' ? [] : [`Severity: ${input.severity}`];
	const context = formatGitReviewCommentContext(input.contextLines);
	return [
		'Git review comment',
		`Comparison: ${source}`,
		`Location: ${formatGitReviewInlineCode(path)}:${input.line} (${input.side === 'before' ? 'old line' : 'new line'})`,
		...severity,
		...context,
		'',
		'Comment:',
		input.body.trim(),
	].join('\n');
}
