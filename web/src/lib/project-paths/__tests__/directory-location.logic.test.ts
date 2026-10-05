import { describe, expect, it } from 'vitest';
import {
	directoryBreadcrumbs,
	isWithinBasePath,
	normalizeDirectoryPath,
	parentDirectoryPath,
	splitTypedDirectoryPath,
} from '$lib/project-paths/directory-location.js';

describe('directory location', () => {
	it('gives one directory one spelling', () => {
		expect(normalizeDirectoryPath('/repo/project/')).toBe('/repo/project');
		expect(normalizeDirectoryPath('/repo/project//')).toBe('/repo/project');
		expect(normalizeDirectoryPath('/repo/project ')).toBe('/repo/project ');
		expect(normalizeDirectoryPath('/')).toBe('/');
		expect(normalizeDirectoryPath('///')).toBe('/');
	});

	it('confines paths to whole segments of the base', () => {
		expect(isWithinBasePath('/repo', '/repo')).toBe(true);
		expect(isWithinBasePath('/repo/', '/repo')).toBe(true);
		expect(isWithinBasePath('/repo/project', '/repo/')).toBe(true);
		expect(isWithinBasePath('/repository', '/repo')).toBe(false);
		expect(isWithinBasePath('/other', '/repo')).toBe(false);
		expect(isWithinBasePath('repo/project', '/repo')).toBe(false);
		expect(isWithinBasePath('/anything/below', '/')).toBe(true);
	});

	it('splits a typed path into its listed directory and the name under edit', () => {
		expect(splitTypedDirectoryPath('/repo/pro')).toEqual({ directory: '/repo', partial: 'pro' });
		expect(splitTypedDirectoryPath('/repo/Project ')).toEqual({
			directory: '/repo',
			partial: 'Project ',
		});
		expect(splitTypedDirectoryPath('/repo/')).toEqual({ directory: '/repo', partial: '' });
		expect(splitTypedDirectoryPath('/repo')).toEqual({ directory: '/', partial: 'repo' });
		expect(splitTypedDirectoryPath('relative')).toEqual({ directory: '/', partial: '' });
	});

	it('stops upward navigation at the base', () => {
		expect(parentDirectoryPath('/repo/a/b', '/repo')).toBe('/repo/a');
		expect(parentDirectoryPath('/repo/a/', '/repo')).toBe('/repo');
		expect(parentDirectoryPath('/repo', '/repo')).toBeNull();
		expect(parentDirectoryPath('/repo/', '/repo')).toBeNull();
		expect(parentDirectoryPath('/a', '/')).toBe('/');
		expect(parentDirectoryPath('/', '/')).toBeNull();
	});

	it('lists breadcrumbs from the base down to the directory', () => {
		expect(directoryBreadcrumbs('/home/user/projects/app/src', '/home/user/projects')).toEqual([
			{ label: 'projects', path: '/home/user/projects' },
			{ label: 'app', path: '/home/user/projects/app' },
			{ label: 'src', path: '/home/user/projects/app/src' },
		]);
		expect(directoryBreadcrumbs('/repo/', '/repo/')).toEqual([{ label: 'repo', path: '/repo' }]);
		expect(directoryBreadcrumbs('/a/b', '/')).toEqual([
			{ label: '/', path: '/' },
			{ label: 'a', path: '/a' },
			{ label: 'b', path: '/a/b' },
		]);
		expect(directoryBreadcrumbs('/elsewhere', '/repo')).toEqual([{ label: 'repo', path: '/repo' }]);
	});
});
