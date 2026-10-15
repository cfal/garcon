import { describe, expect, it } from 'vitest';
import {
	nextPinnedProjectPaths,
	pinnedProjectPathName,
	sortedPinnedProjectPaths,
} from '$lib/project-paths/project-pinned-paths.js';

describe('project pinned paths', () => {
	it.each([
		['/workspace/dashboard', 'dashboard'],
		['/workspace/Space Project ', 'Space Project '],
		['/workspace/a\\b', 'a\\b'],
		['/workspace/dashboard/', 'dashboard'],
		['/', '/'],
		['C:\\', 'C:\\'],
		['C:/', 'C:/'],
		['C:\\work\\dashboard', 'dashboard'],
		['C:\\work/dashboard\\', 'dashboard'],
		['\\\\server\\share\\dashboard', 'dashboard'],
	])('labels %s without changing path identity', (path, name) => {
		expect(pinnedProjectPathName(path)).toBe(name);
	});

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
