import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitPatchIndex } from '../git-patch-index.js';
import type { GitDiffSyntaxFileInput } from '../git-diff-syntax.js';
import { gitReviewWorker } from '../git-review-worker-client.js';
import { highlightGitDiffFile } from '../git-review-worker-operations.js';

function fixture(): GitDiffSyntaxFileInput {
	const patch = '@@ -1 +1 @@\n-const before = 1;\n+const after = 2;\n';
	const file = {
		path: 'after.ts',
		originalPath: 'before.js',
		bodyFingerprint: 'synthetic',
		category: 'normal' as const,
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
	};
	return {
		documentId: 'remote:synthetic',
		file,
		body: {
			...file,
			bodyState: 'loaded',
			patchDigest: 'a'.repeat(64),
			patch,
			patchBytes: patch.length,
			renderedRowCount: 3,
			patchIndex: createGitPatchIndex(patch),
		},
	};
}

afterEach(() => vi.restoreAllMocks());

describe('Worker syntax adapter', () => {
	it('does not admit pre-aborted or ineligible demand', async () => {
		const run = vi.spyOn(gitReviewWorker, 'run');
		const input = fixture();
		const abort = new AbortController();
		abort.abort();
		expect(await highlightGitDiffFile(input, abort.signal)).toEqual({ status: 'cancelled' });
		input.file.isBinary = true;
		expect(await highlightGitDiffFile(input, new AbortController().signal)).toEqual({
			status: 'plain',
			reason: 'excluded',
		});
		expect(run).not.toHaveBeenCalled();
	});

	it('sends cloneable indexes, rename paths and ownership without transferring retained buffers', async () => {
		const run = vi
			.spyOn(gitReviewWorker, 'run')
			.mockResolvedValue({
				kind: 'highlight',
				attempt: { status: 'plain', reason: 'segment-limit' },
			});
		const input = fixture();
		const signal = new AbortController().signal;
		expect(await highlightGitDiffFile(input, signal)).toEqual({
			status: 'plain',
			reason: 'segment-limit',
		});
		const [request, capturedSignal] = run.mock.calls[0];
		expect(capturedSignal).toBe(signal);
		expect(request).toMatchObject({
			kind: 'highlight',
			documentId: input.documentId,
			file: input.file,
			body: { patchDigest: input.body.patchDigest },
		});
		if (request.kind !== 'highlight') throw new Error('Expected highlight request');
		expect(request.body).not.toHaveProperty('patchIndex');
		const cloned = structuredClone(request);
		expect(cloned.body).toEqual(request.body);
		for (const key of Object.keys(request.index) as (keyof typeof request.index)[]) {
			expect(Array.from(cloned.index[key])).toEqual(Array.from(request.index[key]));
		}
		expect(request.index).toEqual(input.body.patchIndex!.toData());
		expect(input.body.patchIndex!.rowAt(2)).toMatchObject({ text: 'const after = 2;' });
	});

	it.each(['admission limit', 'deadline exceeded', 'Worker unavailable'])(
		'keeps readable plain text after %s instead of rejecting the review',
		async (message) => {
			vi.spyOn(gitReviewWorker, 'run').mockRejectedValue(new Error(message));
			const input = fixture();
			expect(await highlightGitDiffFile(input, new AbortController().signal)).toEqual({
				status: 'plain',
				reason: 'error',
			});
			expect(input.body.patchIndex!.rowAt(2)).toMatchObject({ text: 'const after = 2;' });
		},
	);

	it('distinguishes cancelled in-flight work from a plain-text fallback', async () => {
		const pending = Promise.withResolvers<never>();
		const run = vi.spyOn(gitReviewWorker, 'run').mockReturnValue(pending.promise);
		const abort = new AbortController();
		const result = highlightGitDiffFile(fixture(), abort.signal);
		expect(run).toHaveBeenCalledOnce();
		abort.abort();
		pending.reject(new DOMException('Cancelled', 'AbortError'));
		expect(await result).toEqual({ status: 'cancelled' });
	});
});
