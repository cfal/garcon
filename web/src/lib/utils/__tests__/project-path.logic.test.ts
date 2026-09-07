import { describe, expect, it } from 'vitest';
import {
	isProjectPathAncestor,
	normalizeProjectPath,
	projectPathAndAncestors,
} from '../project-path.js';

describe('normalizeProjectPath', () => {
	it('normalizes separators, trailing slashes, and Windows drive casing', () => {
		expect(normalizeProjectPath(' /workspace//repo/// ')).toBe('/workspace/repo');
		expect(normalizeProjectPath('C:\\workspace\\repo\\')).toBe('c:/workspace/repo');
	});

	it('preserves filesystem roots', () => {
		expect(normalizeProjectPath('/')).toBe('/');
		expect(normalizeProjectPath('C:\\')).toBe('c:');
	});

	it('returns an empty path for blank input', () => {
		expect(normalizeProjectPath('   ')).toBe('');
	});
});

describe('isProjectPathAncestor', () => {
	it('matches exact and separator-bounded descendant paths', () => {
		expect(isProjectPathAncestor('/workspace/repo', '/workspace/repo')).toBe(true);
		expect(isProjectPathAncestor('/workspace/repo/', '/workspace/repo/packages/app')).toBe(true);
		expect(isProjectPathAncestor('/workspace/repo', '/workspace/repository')).toBe(false);
	});

	it('normalizes Windows separators and drive casing', () => {
		expect(isProjectPathAncestor('C:\\workspace\\repo', 'c:/workspace/repo/src')).toBe(true);
	});
});

describe('projectPathAndAncestors', () => {
	it('returns the exact Unix path followed by nearest ancestors', () => {
		expect(projectPathAndAncestors('/repo/.worktrees/abc/')).toEqual([
			'/repo/.worktrees/abc',
			'/repo/.worktrees',
			'/repo',
			'/',
		]);
	});

	it('terminates at Unix and Windows roots', () => {
		expect(projectPathAndAncestors('/')).toEqual(['/']);
		expect(projectPathAndAncestors('C:\\repo\\src')).toEqual(['c:/repo/src', 'c:/repo', 'c:']);
		expect(projectPathAndAncestors('c:')).toEqual(['c:']);
	});

	it('rejects blank and relative paths', () => {
		expect(projectPathAndAncestors('')).toEqual([]);
		expect(projectPathAndAncestors('repo/src')).toEqual([]);
		expect(projectPathAndAncestors('C:repo\\src')).toEqual([]);
	});
});
