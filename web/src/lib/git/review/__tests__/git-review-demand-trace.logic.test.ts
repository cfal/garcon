import { describe, expect, it } from 'vitest';
import { unownedGitReviewLoadingPaths } from '$lib/git/review/git-review-demand-trace.js';

describe('Git review demand diagnostics', () => {
	it('identifies loading paths that have no scheduler owner', () => {
		const pending = new Set(['owned.ts']);

		expect(
			unownedGitReviewLoadingPaths(new Set(['owned.ts', 'orphaned.ts']), (filePath) =>
				pending.has(filePath),
			),
		).toEqual(['orphaned.ts']);
	});
});
