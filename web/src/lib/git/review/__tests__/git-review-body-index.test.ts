import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitReviewFilePatchBody } from '$lib/api/git.js';
import { createIndexedGitReviewFileBody } from '$lib/git/review/git-review-body-index.js';
import { gitReviewWorker } from '../git-review-worker-client.js';
import { createGitPatchIndex, getGitSplitPatchIndex } from '../git-patch-index.js';

afterEach(() => vi.restoreAllMocks());

describe('createIndexedGitReviewFileBody', () => {
	it('hydrates compact Worker indexes without materializing row arrays or lazy getters', async () => {
		vi.spyOn(gitReviewWorker, 'run').mockImplementation(async (input) => {
			if (input.kind !== 'index') throw new Error('Expected index');
			const index = createGitPatchIndex(input.patch, input.renderedRowCount);
			return structuredClone({
				kind: 'index',
				index: index.toData(),
				split: getGitSplitPatchIndex(index).toData(),
			});
		});
		performance.clearMeasures();
		const patch = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 same
-old
+new
`;
		const body: GitReviewFilePatchBody = {
			patchDigest: 'a'.repeat(64),
			path: 'file.txt',
			bodyFingerprint: 'fingerprint',
			bodyState: 'loaded',
			category: 'normal',
			isBinary: false,
			isTooLarge: false,
			renderedRowCount: 4,
			patchBytes: new TextEncoder().encode(patch).byteLength,
			patch,
		};

		const indexed = await createIndexedGitReviewFileBody(body);

		expect(performance.getEntriesByName('garcon.git-review.patch-index', 'measure')).toHaveLength(
			0,
		);
		expect(indexed.patchIndex?.rowCount).toBe(4);
		expect(Object.getOwnPropertyDescriptor(indexed, 'patchIndex')?.get).toBeUndefined();
		expect(indexed.patchIndex?.rowAt(2)).toMatchObject({
			key: 'line:1:del:2',
			beforeLine: 2,
			text: 'old',
		});
		expect(indexed.patchIndex?.hunkAt(0)).toEqual({
			id: 'hunk-0',
			header: '@@ -1,2 +1,2 @@',
			oldStart: 1,
			oldLines: 2,
			newStart: 1,
			newLines: 2,
			rowStartIndex: 0,
			rowEndIndex: 3,
		});
	});

	it('preserves terminal body metadata without indexing', async () => {
		const body: GitReviewFilePatchBody = {
			patchDigest: 'a'.repeat(64),
			path: 'image.png',
			bodyFingerprint: 'fingerprint',
			bodyState: 'binary',
			category: 'binary',
			isBinary: true,
			isTooLarge: false,
			renderedRowCount: 0,
			patchBytes: 0,
			patch: null,
			limitReason: 'binary',
			limitMessage: 'Binary diff is not available.',
		};

		expect(await createIndexedGitReviewFileBody(body)).toEqual({
			...body,
			patchIndex: null,
		});
	});
});
