import type { GitReviewFileBody, GitReviewFilePatchBody } from '$lib/api/git.js';
import { gitReviewWorker } from './git-review-worker-client.js';
import { restoreGitPatchIndex } from './git-patch-index.js';

export async function createIndexedGitReviewFileBody(
	body: GitReviewFilePatchBody,
	signal?: AbortSignal,
): Promise<GitReviewFileBody> {
	if (signal?.aborted) throw new DOMException('Diff work cancelled.', 'AbortError');
	if (body.bodyState !== 'loaded' || body.patch === null) return { ...body, patchIndex: null };
	const output = await gitReviewWorker.run(
		{ kind: 'index', patch: body.patch, renderedRowCount: body.renderedRowCount },
		signal,
	);
	if (output.kind !== 'index') throw new Error('Invalid diff index reply.');
	return { ...body, patchIndex: restoreGitPatchIndex(body.patch, output.index, output.split) };
}
