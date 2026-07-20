import { describe, expect, it } from 'vitest';
import {
	nextPinnedProjectPaths,
	sortedPinnedProjectPaths,
} from '$lib/chat/project-paths/project-pinned-paths.js';

describe('project pinned paths', () => {
	it('sorts, trims, and dedupes pinned project paths', () => {
		expect(
			sortedPinnedProjectPaths([
				'/workspace/zeta',
				' /workspace/alpha ',
				'/workspace/beta',
				'/workspace/alpha',
				'',
			]),
		).toEqual(['/workspace/alpha', '/workspace/beta', '/workspace/zeta']);
	});

	it('returns alphabetized paths after pinning or unpinning', () => {
		expect(nextPinnedProjectPaths(['/workspace/zeta'], '/workspace/alpha')).toEqual([
			'/workspace/alpha',
			'/workspace/zeta',
		]);

		expect(
			nextPinnedProjectPaths(['/workspace/zeta', '/workspace/alpha'], '/workspace/zeta'),
		).toEqual(['/workspace/alpha']);
	});
});
