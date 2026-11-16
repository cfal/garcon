import { describe, expect, it } from 'vitest';
import {
	nextPinnedProjectPaths,
	isPinnedProjectPath,
	sortedPinnedProjectPaths,
} from '$lib/project-paths/project-pinned-paths.js';

describe('project pinned paths', () => {
	it('sorts and dedupes exact nonblank pinned project paths', () => {
		expect(
			sortedPinnedProjectPaths([
				'/workspace/zeta',
				' /workspace/alpha ',
				'/workspace/beta',
				'/workspace/alpha',
				'/workspace/alpha',
				'',
				'   ',
			]),
		).toEqual([' /workspace/alpha ', '/workspace/alpha', '/workspace/beta', '/workspace/zeta']);
	});

	it('preserves pin age after pinning or unpinning', () => {
		expect(nextPinnedProjectPaths(['/workspace/zeta'], '/workspace/alpha')).toEqual([
			'/workspace/zeta',
			'/workspace/alpha',
		]);

		expect(
			nextPinnedProjectPaths(['/workspace/zeta', '/workspace/alpha'], '/workspace/zeta'),
		).toEqual(['/workspace/alpha']);
	});

	it('replaces the oldest of five pins and recognizes Windows slash aliases', () => {
		expect(nextPinnedProjectPaths(['/z', '/b', '/c', '/d', '/a'], '/new'))
			.toEqual(['/b', '/c', '/d', '/a', '/new']);
		expect(isPinnedProjectPath(['D:\\projects\\one'], 'D:/projects/one')).toBe(true);
		expect(nextPinnedProjectPaths(['D:\\projects\\one', '/other'], 'D:/projects/one')).toEqual(['/other']);
		expect(nextPinnedProjectPaths(['/one\\two'], '/one/two')).toEqual(['/one\\two', '/one/two']);
	});
});
