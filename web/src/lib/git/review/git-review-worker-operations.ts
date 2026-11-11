import { gitReviewWorker } from './git-review-worker-client.js';
import { restoreGitDiffSyntax } from './git-diff-syntax-transfer.js';
import {
	gitDiffSyntaxSkipReason,
	type GitDiffSyntaxAttempt,
	type GitDiffSyntaxFileInput,
} from './git-diff-syntax.js';

export async function highlightGitDiffFile(
	input: GitDiffSyntaxFileInput,
	signal: AbortSignal,
): Promise<GitDiffSyntaxAttempt> {
	if (signal.aborted) return { status: 'cancelled' };
	const skip = gitDiffSyntaxSkipReason(input);
	if (skip) return { status: 'plain', reason: skip };
	const { patchIndex, ...body } = input.body;
	if (!patchIndex) return { status: 'plain', reason: 'error' };
	try {
		const output = await gitReviewWorker.run(
			{
				kind: 'highlight',
				documentId: input.documentId,
				file: {
					path: input.file.path,
					originalPath: input.file.originalPath,
					bodyFingerprint: input.file.bodyFingerprint,
					category: input.file.category,
					isGenerated: input.file.isGenerated,
					isBinary: input.file.isBinary,
					isTooLarge: input.file.isTooLarge,
				},
				body,
				index: patchIndex.toData(),
			},
			signal,
		);
		return output.kind === 'highlight'
			? restoreGitDiffSyntax(output.attempt)
			: { status: 'plain', reason: 'error' };
	} catch {
		return signal.aborted ? { status: 'cancelled' } : { status: 'plain', reason: 'error' };
	}
}
