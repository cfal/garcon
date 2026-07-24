import { describe, expect, it } from 'vitest';
import {
	createGitPatchIndex,
	getGitSplitPatchIndex,
} from '$lib/git/review/git-patch-index.js';

const PATCH = `diff --git a/src/file.ts b/src/file.ts
--- a/src/file.ts
+++ b/src/file.ts
@@ -2,3 +2,4 @@ function example() {
 context
-old
+new
+added
 context two
@@ -20 +21 @@
-last old
+last new
\\ No newline at end of file
`;

describe('createGitPatchIndex', () => {
	it('indexes unified rows and hunks with legacy-compatible values', () => {
		const index = createGitPatchIndex(PATCH, 9);

		expect(index.rowCount).toBe(9);
		expect(index.hunkCount).toBe(2);
		expect(index.rowAt(0)).toEqual({
			key: 'hunk:0:hunk-0',
			kind: 'hunk',
			hunkIndex: 0,
			hunkId: 'hunk-0',
			beforeLine: null,
			afterLine: null,
			text: '@@ -2,3 +2,4 @@ function example() {',
			diffLineIndex: -1,
		});
		expect(index.rowAt(2)).toMatchObject({
			key: 'line:1:del:3',
			kind: 'del',
			beforeLine: 3,
			afterLine: null,
			text: 'old',
			diffLineIndex: 1,
		});
		expect(index.rowAt(3)).toMatchObject({
			key: 'line:2:add:3',
			kind: 'add',
			beforeLine: null,
			afterLine: 3,
			text: 'new',
		});
		expect(index.hunkAt(0)).toEqual({
			id: 'hunk-0',
			header: '@@ -2,3 +2,4 @@ function example() {',
			oldStart: 2,
			oldLines: 3,
			newStart: 2,
			newLines: 4,
			rowStartIndex: 0,
			rowEndIndex: 5,
		});
		expect(index.hunkAt(1).rowEndIndex).toBe(8);
	});

	it('rejects a server row count mismatch', () => {
		expect(() => createGitPatchIndex(PATCH, 10)).toThrow('Diff row count mismatch');
		expect(() => createGitPatchIndex(PATCH, 0)).toThrow('Diff row count mismatch');
	});

	it('indexes both sections of a file type change', () => {
		const patch = `diff --git a/link b/link
deleted file mode 100644
@@ -1 +0,0 @@
-old
diff --git a/link b/link
new file mode 120000
@@ -0,0 +1 @@
+target
`;
		const index = createGitPatchIndex(patch, 4);

		expect(index.hunkCount).toBe(2);
		expect(index.rowAt(1).text).toBe('old');
		expect(index.rowAt(3).text).toBe('target');
	});

	it('keeps a large patch in typed indexes without a row object array', () => {
		const rows = Array.from({ length: 50_000 }, (_, index) => `+line ${index}`).join('\n');
		const patch = `diff --git a/large.txt b/large.txt\n@@ -0,0 +1,50000 @@\n${rows}\n`;
		const index = createGitPatchIndex(patch, 50_001);

		expect(index.rowCount).toBe(50_001);
		expect(index.rowAt(50_000).text).toBe('line 49999');
		expect(Object.values(index).some((value) => Array.isArray(value))).toBe(false);
	});

	it('reuses split alignment for the lifetime of a patch index', () => {
		const index = createGitPatchIndex(PATCH, 9);

		expect(getGitSplitPatchIndex(index)).toBe(getGitSplitPatchIndex(index));
	});
});
