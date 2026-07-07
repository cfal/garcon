// Builds the chat prompts sent to the coding agent from the pull request pane.
// Keeps the "hand a PR entity to the agent" phrasing in one place.

import type { PullRequestDetail, PullRequestThread } from '$lib/api/pull-requests';

export function buildReviewPrompt(pr: PullRequestDetail): string {
	return [
		`Review pull request #${pr.number} "${pr.title}" (${pr.headRefName} → ${pr.baseRefName}).`,
		pr.url,
		'',
		`Run \`gh pr diff ${pr.number}\` to see the full change, then give a thorough code review focused on correctness, bugs, edge cases, and clarity. Call out anything that should block merge.`,
	].join('\n');
}

export function buildAddressThreadPrompt(
	pr: PullRequestDetail,
	thread: PullRequestThread,
): string {
	const quoted = thread.comments
		.map((comment) => `> ${comment.author}: ${comment.body.replace(/\n/g, '\n> ')}`)
		.join('\n>\n');
	const location = thread.line > 0 ? `${thread.path}:${thread.line}` : thread.path;
	return [
		`In pull request #${pr.number}, address this review comment on \`${location}\`:`,
		'',
		quoted,
		'',
		'Make the necessary code changes to resolve it.',
	].join('\n');
}
