import { describe, expect, it } from 'vitest';
import type { PullRequestThread } from '$lib/api/pull-requests.js';
import type { GitReviewFileBody, GitReviewFileSummary } from '$lib/api/git.js';
import { buildPullRequestVirtualRowSource } from '../pull-request-virtual-row-source.js';
import { createGitPatchIndex } from '$lib/git/review/git-patch-index.js';
import { buildGitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';

const limits = {
	maxSummaryFiles: 10_000,
	maxBodyBatchFiles: 24,
	maxLoadedRows: 100_000,
	maxLoadedPatchBytes: 10_000_000,
	maxFileRows: 50_000,
	maxFilePatchBytes: 5_000_000,
	maxLineBytes: 20_000,
	maxContextLines: 50,
	bodyConcurrency: 4,
};

function file(path: string): GitReviewFileSummary {
	return {
		path,
		indexStatus: ' ',
		workTreeStatus: 'M',
		category: 'normal',
		additions: 1,
		deletions: 1,
		estimatedRows: 4,
		bodyState: 'loaded',
		bodyFingerprint: `fingerprint:${path}`,
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
	};
}

function body(path: string): GitReviewFileBody {
	const patch = `diff --git a/${path} b/${path}
@@ -1,2 +1,2 @@
 keep
-old
+new
`;
	const patchIndex = createGitPatchIndex(patch, 4);
	return {
		path,
		bodyFingerprint: `fingerprint:${path}`,
		bodyState: 'loaded',
		category: 'normal',
		isBinary: false,
		isTooLarge: false,
		renderedRowCount: patchIndex.rowCount,
		patchBytes: patch.length,
		patch,
		patchIndex,
	};
}

function thread(path: string, line: number, id = `${path}:${line}`): PullRequestThread {
	return {
		id,
		path,
		side: 'after',
		line,
		diffHunk: '@@ -1,2 +1,2 @@',
		isOutdated: false,
		comments: [
			{
				id: 1,
				author: 'reviewer',
				body: 'Please revisit this line.',
				createdAt: '2026-07-24T00:00:00Z',
			},
		],
	};
}

function source(
	files: GitReviewFileSummary[],
	fileBodies: Record<string, GitReviewFileBody>,
	threads: PullRequestThread[],
	collapsedFilePaths = new Set<string>(),
) {
	const baseSource = buildGitVirtualReviewRowSource({
		summary: {
			documentId: 'pull-request:1',
			project: '',
			context: 3,
			files,
			limits,
		},
		visibleFilePaths: files.map((entry) => entry.path),
		fileBodies,
		loadingBodies: new Set(),
		focusedFilePath: null,
		diffMode: 'unified',
		contextLines: 3,
		interaction: { kind: 'read-only' },
		collapsedFilePaths,
	});
	return buildPullRequestVirtualRowSource({
		baseSource,
		files,
		fileBodies,
		threads,
		collapsedFilePaths,
	});
}

describe('pull request virtual row source', () => {
	it('inserts a thread after its matching diff line', () => {
		const reviewFile = file('src/app.ts');
		const reviewBody = body(reviewFile.path);
		const rowSource = source(
			[reviewFile],
			{ [reviewFile.path]: reviewBody },
			[thread(reviewFile.path, 2)],
		);

		expect(rowSource.rowAt(4)).toMatchObject({
			kind: 'unified-row',
			view: { row: { afterLine: 2 } },
		});
		expect(rowSource.rowAt(5)).toMatchObject({
			kind: 'review-thread',
			threadId: 'src/app.ts:2',
			showUnanchoredLabel: false,
		});
	});

	it('places unmatched threads at file end and labels only the first one', () => {
		const reviewFile = file('src/app.ts');
		const reviewBody = body(reviewFile.path);
		const rowSource = source(
			[reviewFile],
			{ [reviewFile.path]: reviewBody },
			[thread(reviewFile.path, 98, 'orphan-1'), thread(reviewFile.path, 99, 'orphan-2')],
		);

		expect(rowSource.rowsInRange(5, 7)).toMatchObject([
			{ kind: 'review-thread', threadId: 'orphan-1', showUnanchoredLabel: true },
			{ kind: 'review-thread', threadId: 'orphan-2', showUnanchoredLabel: false },
		]);
	});

	it('hides collapsed threads and adjusts later file offsets for visible threads', () => {
		const first = file('src/first.ts');
		const second = file('src/second.ts');
		const fileBodies = {
			[first.path]: body(first.path),
			[second.path]: body(second.path),
		};
		const visible = source(
			[first, second],
			fileBodies,
			[thread(first.path, 2)],
		);
		const collapsed = source(
			[first],
			{ [first.path]: fileBodies[first.path] },
			[thread(first.path, 2)],
			new Set([first.path]),
		);

		expect(visible.fileStart(second.path)).toBe(6);
		expect(collapsed.rowCount).toBe(1);
		expect(collapsed.rowsInRange(0, 2)).toMatchObject([{ kind: 'file-header' }]);
	});
});
