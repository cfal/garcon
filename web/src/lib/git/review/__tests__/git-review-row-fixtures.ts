import type { GitReviewFileBody, GitReviewFileSummary } from '$lib/api/git.js';
import type { BuildVirtualRowsOptions } from '$lib/git/review/git-virtual-review-document.svelte.js';
import { createGitPatchIndex } from '$lib/git/review/git-patch-index.js';

export function reviewFileSummary(path: string, renderedRows: number): GitReviewFileSummary {
	return {
		path,
		indexStatus: 'M',
		workTreeStatus: 'M',
		category: 'normal',
		additions: renderedRows,
		deletions: 0,
		estimatedRows: renderedRows,
		bodyState: 'unloaded',
		bodyFingerprint: `fingerprint:${path}`,
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
	};
}

export function indexedBody(path: string, lineCount: number): GitReviewFileBody {
	const lines = Array.from({ length: lineCount }, (_, index) => `+line ${index}`).join('\n');
	const patch = `diff --git a/${path} b/${path}\n@@ -0,0 +1,${lineCount} @@\n${lines}\n`;
	const patchIndex = createGitPatchIndex(patch, lineCount + 1);
	return {
		path,
		bodyFingerprint: `fingerprint:${path}`,
		bodyState: 'loaded',
		category: 'normal',
		isBinary: false,
		isTooLarge: false,
		renderedRowCount: lineCount + 1,
		patchBytes: patch.length,
		patch,
		patchIndex,
	};
}

export function reviewRowOptions(
	files: GitReviewFileSummary[],
	bodies: Record<string, GitReviewFileBody>,
): BuildVirtualRowsOptions {
	return {
		summary: {
			document: { executorId: 'local', instanceId: 'test-instance', documentId: 'document' },
			documentId: 'document',
			project: '/project',
			context: 3,
			files,
			limits: {
				maxSummaryFiles: 10_000,
				maxBodyBatchFiles: 24,
				maxLoadedRows: 100_000,
				maxLoadedPatchBytes: 10_000_000,
				maxFileRows: 50_000,
				maxFilePatchBytes: 5_000_000,
				maxLineBytes: 20_000,
				maxContextLines: 50,
				bodyConcurrency: 4,
			},
		},
		visibleFilePaths: files.map((file) => file.path),
		fileBodies: bodies,
		loadingBodies: new Set<string>(),
		focusedFilePath: null,
		diffMode: 'unified' as const,
		contextLines: 3,
		interaction: { kind: 'read-only' as const },
	};
}
