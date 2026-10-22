import { describe, expect, it } from 'vitest';
import {
	formatCompactProjectPath,
	splitProjectPath,
} from '$lib/project-paths/compact-project-path';

describe('formatCompactProjectPath', () => {
	it('keeps paths that fit within the display limit', () => {
		expect(formatCompactProjectPath('/workspace/project-a')).toBe('/workspace/project-a');
	});

	it('keeps the longest complete suffix that fits when a path is too long', () => {
		expect(formatCompactProjectPath('/workspace/clients/acme/products/garcon/project-a')).toBe(
			'\u2026/acme/products/garcon/project-a',
		);
	});
});

describe('splitProjectPath', () => {
	it('separates the final segment from its parent directory', () => {
		expect(splitProjectPath('/workspace/clients/acme/project-a')).toEqual({
			name: 'project-a',
			parent: '/workspace/clients/acme',
		});
	});

	it('ignores trailing separators', () => {
		expect(splitProjectPath('/workspace/project-a/')).toEqual({
			name: 'project-a',
			parent: '/workspace',
		});
	});

	it('keeps the filesystem root as the parent of top-level directories', () => {
		expect(splitProjectPath('/workspace')).toEqual({ name: 'workspace', parent: '/' });
		expect(splitProjectPath('/')).toEqual({ name: '/', parent: '' });
	});

	it('splits Windows paths', () => {
		expect(splitProjectPath('C:\\Users\\demo\\project-a')).toEqual({
			name: 'project-a',
			parent: 'C:\\Users\\demo',
		});
	});

	it('keeps the drive root separator for top-level Windows directories', () => {
		const driveRootChild = { name: 'workspace', parent: 'C:\\' };
		expect(splitProjectPath('C:\\workspace')).toEqual(driveRootChild);
		expect(splitProjectPath('C:\\workspace\\')).toEqual(driveRootChild);
		expect(splitProjectPath('C:\\')).toEqual({ name: 'C:\\', parent: '' });
	});

	it('returns relative single-segment paths without a parent', () => {
		expect(splitProjectPath('project-a')).toEqual({ name: 'project-a', parent: '' });
	});
});
