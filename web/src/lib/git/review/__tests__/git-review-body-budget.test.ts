import { describe, expect, it } from 'vitest';
import type { GitReviewFileBody } from '$lib/api/git.js';
import {
	decideGitReviewBodyBudget,
	gitReviewBodyBytes,
} from '$lib/git/review/git-review-body-budget.js';
import { createGitPatchIndex, getGitSplitPatchIndex } from '../git-patch-index.js';

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
		patchDigest: 'a'.repeat(64),
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
	it('accounts for indexed short lines and reserves lazy split arrays once', () => {
		const patch = '@@ -1,3 +1,3 @@\n a\n b\n c\n';
		const index = createGitPatchIndex(patch);
		const indexed = { ...body('small.ts', index.rowCount, patch.length), patch, patchIndex: index };
		const arrayBytes = Object.values(index.toData()).reduce(
			(total, array) => total + array.byteLength,
			0,
		);
		const estimate = patch.length * 2 + arrayBytes + index.rowCount * 8;
		expect(gitReviewBodyBytes(indexed)).toBe(estimate);
		getGitSplitPatchIndex(index);
		expect(gitReviewBodyBytes(indexed)).toBe(estimate);
		expect(
			decideGitReviewBodyBudget(indexed, 'prefetch', {}, new Set(), {
				...limits,
				maxLoadedPatchBytes: estimate - 1,
			}),
		).toMatchObject({ accept: false, reason: 'collection-too-many-bytes' });
		expect(
			decideGitReviewBodyBudget(indexed, 'visible', {}, new Set(), {
				...limits,
				maxLoadedPatchBytes: estimate,
			}),
		).toMatchObject({ accept: true });
	});

	it('keeps one server-admitted visible body inspectable without displacing pinned bodies', () => {
		const large = { ...body('large.ts', 5, 90), patch: 'x'.repeat(90) };
		expect(gitReviewBodyBytes(large)).toBe(180);
		expect(
			decideGitReviewBodyBudget(
				large,
				'visible',
				{
					'old.ts': body('old.ts', 1, 20),
				},
				new Set(),
				limits,
			),
		).toMatchObject({ accept: true, evictedPaths: ['old.ts'] });
		expect(
			decideGitReviewBodyBudget(
				large,
				'visible',
				{
					'pinned.ts': body('pinned.ts', 1, 20),
				},
				new Set(['pinned.ts']),
				limits,
			),
		).toMatchObject({ accept: false });
		expect(decideGitReviewBodyBudget(large, 'prefetch', {}, new Set(), limits)).toMatchObject({
			accept: false,
		});
		expect(
			decideGitReviewBodyBudget({ ...large, patchBytes: 101 }, 'visible', {}, new Set(), limits),
		).toMatchObject({ accept: false });
	});

	it('lets a visible body replace speculative bodies', () => {
		const current = {
			'a.ts': body('a.ts', 6, 60),
			'b.ts': body('b.ts', 4, 40),
		};
		const decision = decideGitReviewBodyBudget(
			body('selected.ts', 6, 60),
			'visible',
			current,
			new Set(['b.ts']),
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
			new Set(),
			limits,
		);

		expect(decision).toMatchObject({
			accept: false,
			evictedPaths: [],
			reason: 'collection-too-many-rows',
		});
	});

	it('lets visible loading recycle any body that is no longer pinned', () => {
		const decision = decideGitReviewBodyBudget(
			body('new-visible.ts', 6, 60),
			'visible',
			{ 'old-visible.ts': body('old-visible.ts', 6, 60) },
			new Set(),
			limits,
		);

		expect(decision).toMatchObject({
			accept: true,
			evictedPaths: ['old-visible.ts'],
		});
	});

	it('accepts a per-file limit without imposing a collection limit', () => {
		const limited: GitReviewFileBody = {
			...body('b.ts', 0, 0),
			bodyState: 'too-large',
			category: 'large',
			isTooLarge: true,
			patch: null,
			patchIndex: null,
			limitReason: 'file-too-many-bytes',
			limitMessage: 'File exceeds the patch byte limit.',
		};

		expect(
			decideGitReviewBodyBudget(
				limited,
				'visible',
				{
					'a.ts': body('a.ts', 8, 80),
				},
				new Set(['a.ts']),
				limits,
			),
		).toEqual({
			accept: true,
			evictedPaths: [],
			loadedRows: 0,
			loadedBytes: 0,
		});
	});
});
