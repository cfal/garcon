import { describe, expect, it } from 'vitest';
import type { GitReviewFilePatchBody } from '$lib/api/git.js';
import { materializeLegacyReviewBody } from '$lib/git/review/git-review-body-bridge.js';

describe('materializeLegacyReviewBody', () => {
	it('reproduces rendered rows and hunks from a compact patch body', () => {
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

		const materialized = materializeLegacyReviewBody(body);

		expect(materialized.rows.map((row) => row.kind)).toEqual(['hunk', 'context', 'del', 'add']);
		expect(materialized.rows[2]).toMatchObject({
			key: 'line:1:del:2',
			beforeLine: 2,
			text: 'old',
		});
		expect(materialized.hunks).toEqual([
			{
				id: 'hunk-0',
				header: '@@ -1,2 +1,2 @@',
				oldStart: 1,
				oldLines: 2,
				newStart: 1,
				newLines: 2,
				rowStartIndex: 0,
				rowEndIndex: 3,
			},
		]);
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

		expect(materializeLegacyReviewBody(body)).toEqual({
			...body,
			rows: [],
			hunks: [],
		});
	});
});
