import { describe, expect, it } from 'vitest';
import type { GitReviewFilePatchBody } from '$lib/api/git.js';
import { createIndexedGitReviewFileBody } from '$lib/git/review/git-review-body-index.js';

describe('createIndexedGitReviewFileBody', () => {
	it('indexes a compact patch body without materializing row arrays', () => {
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

		const indexed = createIndexedGitReviewFileBody(body);

		expect(performance.getEntriesByName('garcon.git-review.patch-index', 'measure')).toHaveLength(0);
		expect(indexed.patchIndex?.rowCount).toBe(4);
		expect(performance.getEntriesByName('garcon.git-review.patch-index', 'measure')).toHaveLength(1);
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

	it('preserves terminal body metadata without indexing', () => {
		const body: GitReviewFilePatchBody = {
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

		expect(createIndexedGitReviewFileBody(body)).toEqual({
			...body,
			patchIndex: null,
		});
	});
});
