import { describe, expect, it } from 'vitest';
import {
	normalizeGitReviewDemandFilePaths,
	sameGitReviewViewportDemand,
	type GitReviewViewportDemand,
} from '$lib/git/review/git-review-body-demand.js';

function viewportDemand(documentId: string, filePaths: readonly string[]): GitReviewViewportDemand {
	return { kind: 'viewport', documentId, filePaths };
}

describe('Git review body demand', () => {
	it('normalizes paths without changing their priority order', () => {
		expect(
			normalizeGitReviewDemandFilePaths(['a.ts', null, 'b.ts', 'a.ts', undefined, '', 'c.ts']),
		).toEqual(['a.ts', 'b.ts', 'c.ts']);
	});

	it('compares the document, path order, and path membership', () => {
		const demand = viewportDemand('doc-a', ['a.ts', 'b.ts']);

		expect(sameGitReviewViewportDemand(null, demand)).toBe(false);
		expect(sameGitReviewViewportDemand(viewportDemand('doc-a', ['a.ts', 'b.ts']), demand)).toBe(
			true,
		);
		expect(sameGitReviewViewportDemand(viewportDemand('doc-b', ['a.ts', 'b.ts']), demand)).toBe(
			false,
		);
		expect(sameGitReviewViewportDemand(viewportDemand('doc-a', ['b.ts', 'a.ts']), demand)).toBe(
			false,
		);
	});
});
