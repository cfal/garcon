import { describe, expect, it } from 'vitest';
import type { GitReviewBodyPurpose, GitReviewFileBody } from '$lib/api/git.js';
import {
	collectionLimitDecisionFromGitReviewBody,
	decideGitReviewBodyBudget,
} from '$lib/git/review/git-review-body-budget.js';

const limits = {
	maxSummaryFiles: 100,
	maxBodyBatchFiles: 24,
	maxLoadedRows: 10,
	maxLoadedPatchBytes: 100,
	maxFileRows: 10,
	maxFilePatchBytes: 100,
	maxLineBytes: 100,
	maxContextLines: 20,
	bodyConcurrency: 4,
};

function body(path: string, rows: number, bytes: number): GitReviewFileBody {
	return {
		path,
		bodyFingerprint: `fingerprint:${path}`,
		bodyState: 'loaded',
		category: 'normal',
		isBinary: false,
		isTooLarge: false,
		renderedRowCount: rows,
		patchBytes: bytes,
		patch: '',
		patchIndex: null,
	};
}

describe('Git review body budget', () => {
	it('lets a visible body replace speculative bodies', () => {
		const current = {
			'a.ts': body('a.ts', 6, 60),
			'b.ts': body('b.ts', 4, 40),
		};
		const decision = decideGitReviewBodyBudget(
			body('selected.ts', 6, 60),
			'visible',
			current,
			new Map<string, GitReviewBodyPurpose>([
				['a.ts', 'prefetch'],
				['b.ts', 'visible'],
			]),
			limits,
		);

		expect(decision).toMatchObject({
			accept: true,
			evictedPaths: ['a.ts'],
			loadedRows: 4,
			loadedBytes: 40,
		});
	});

	it('stops prefetch instead of evicting visible bodies', () => {
		const current = { 'a.ts': body('a.ts', 8, 80) };
		const decision = decideGitReviewBodyBudget(
			body('b.ts', 4, 40),
			'prefetch',
			current,
			new Map<string, GitReviewBodyPurpose>([['a.ts', 'visible']]),
			limits,
		);

		expect(decision).toMatchObject({
			accept: false,
			evictedPaths: [],
			reason: 'collection-too-many-rows',
		});
	});

	it('recognizes a collection limit emitted by the server', () => {
		const limited: GitReviewFileBody = {
			...body('b.ts', 0, 0),
			bodyState: 'too-large',
			category: 'large',
			isTooLarge: true,
			patch: null,
			patchIndex: null,
			limitReason: 'collection-too-many-bytes',
			limitMessage: 'Stopped loading after 80 patch bytes.',
		};

		expect(
			collectionLimitDecisionFromGitReviewBody(limited, {
				'a.ts': body('a.ts', 8, 80),
			}),
		).toEqual({
			accept: false,
			evictedPaths: [],
			loadedRows: 8,
			loadedBytes: 80,
			reason: 'collection-too-many-bytes',
		});
	});
});
