import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ApiMutationOutcomeUnknownError } from '$lib/api/client';
import { browseDirectory, createDirectory } from '$lib/api/files';
import type { DirectoryEntry } from '$shared/file-contracts';
import { openDirectoryBrowser } from './directory-browser-harness.svelte.js';

vi.mock('$lib/api/files', () => ({ browseDirectory: vi.fn(), createDirectory: vi.fn() }));

type Harness = ReturnType<typeof openDirectoryBrowser>;

const directories = new Map<string, string[]>();
const harnesses: Harness[] = [];

function entries(directory: string): DirectoryEntry[] {
	return (directories.get(directory) ?? []).map((name) => ({
		name,
		path: `${directory === '/' ? '' : directory}/${name}`,
		type: 'directory',
	}));
}

function open(options: Parameters<typeof openDirectoryBrowser>[0]): Harness {
	const harness = openDirectoryBrowser(options);
	harnesses.push(harness);
	return harness;
}

// Lets settled requests and the effects they trigger run to quiescence.
async function settle(): Promise<void> {
	for (let turn = 0; turn < 4; turn += 1) {
		await Promise.resolve();
		flushSync();
	}
}

function names(harness: Harness): string[] {
	return harness.browser.entries.map((entry) => entry.name);
}

function browsedPaths(): string[] {
	return vi.mocked(browseDirectory).mock.calls.map(([path]) => path);
}

beforeEach(() => {
	directories.clear();
	directories.set('/repo', ['alpha', 'alpha-two', 'beta']);
	directories.set('/repo/alpha', ['alpine', 'nested']);
	directories.set('/repo/alpha/nested', []);
	directories.set('/repo/alpha-two', []);
	directories.set('/repo/beta', []);
	vi.mocked(browseDirectory).mockImplementation(async (path) => {
		if (!directories.has(path)) throw new ApiError(404, 'File or directory not found', 'FILE_NOT_FOUND');
		return entries(path);
	});
	vi.mocked(createDirectory).mockImplementation(async ({ parentPath, name }) => {
		const siblings = directories.get(parentPath) ?? [];
		if (siblings.includes(name)) throw new ApiError(409, 'Exists', 'FILE_ALREADY_EXISTS');
		const path = `${parentPath}/${name}`;
		directories.set(parentPath, [...siblings, name]);
		directories.set(path, []);
		return { name, path, type: 'directory' };
	});
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.dispose();
	vi.resetAllMocks();
});

describe('DirectoryBrowserState following a typed path', () => {
	it('lists the parent of a typed name and filters by it without refetching', async () => {
		const field = open({ currentPath: '/repo/al' });
		expect(field.browser.listing.status).toBe('loading');
		await settle();
		expect(field.browser.directory).toBe('/repo');
		expect(names(field)).toEqual(['alpha', 'alpha-two']);
		field.type('/repo/ALPHA-');
		expect(names(field)).toEqual(['alpha-two']);
		field.type('/repo/alpha ');
		expect(names(field)).toEqual([]);
		expect(browsedPaths()).toEqual(['/repo']);
	});

	it('lists a navigated directory unfiltered and publishes it to the field', async () => {
		const field = open({ currentPath: '/repo' });
		await settle();
		field.browser.navigate('/repo/alpha');
		await settle();
		expect(field.selections).toEqual(['/repo/alpha']);
		expect(field.browser.directory).toBe('/repo/alpha');
		expect(names(field)).toEqual(['alpine', 'nested']);
		field.browser.navigate('/repo/alpha/nested');
		await settle();
		expect(field.browser.directory).toBe('/repo/alpha/nested');
		expect(field.browser.breadcrumbs.map((crumb) => crumb.label)).toEqual(['repo', 'alpha', 'nested']);
		expect(field.browser.parentPath).toBe('/repo/alpha');

		field.type('/repo/alpha/ne');
		await settle();
		expect(field.browser.directory).toBe('/repo/alpha');
		expect(names(field)).toEqual(['nested']);
	});

	it('lists a path ending in a separator as one normalized directory', async () => {
		const field = open({ currentPath: '/repo/alpha/' });
		await settle();
		expect(browsedPaths()).toEqual(['/repo/alpha']);
		expect(field.browser.parentPath).toBe('/repo');
		field.type('/repo/');
		await settle();
		expect(field.browser.directory).toBe('/repo');
		expect(field.browser.parentPath).toBeNull();
	});

	it('lists nothing until its host knows the base', async () => {
		for (const confirmsSelection of [false, true]) {
			const field = open({ basePath: '', currentPath: '', confirmsSelection });
			await settle();
			expect(browseDirectory).not.toHaveBeenCalled();
			expect(field.browser.listing.status).toBe('loading');
			expect(field.browser.canConfirm).toBe(false);
			field.resolveBase('/repo');
			await settle();
			expect(browsedPaths()).toEqual(['/repo']);
			expect(names(field)).toEqual(['alpha', 'alpha-two', 'beta']);
			vi.mocked(browseDirectory).mockClear();
		}
	});

	it('stays inside the base', async () => {
		const field = open({ currentPath: '/repository/elsewhere' });
		await settle();
		expect(field.browser.directory).toBe('/repo');
		field.browser.navigate('/');
		field.browser.navigate('/repository');
		expect(field.selections).toEqual([]);
		expect(field.browser.directory).toBe('/repo');
	});

	it('drops navigation and the filter of another executor, and fences its late listing', async () => {
		const stale = Promise.withResolvers<DirectoryEntry[]>();
		const field = open({ currentPath: '/repo' });
		await settle();
		field.browser.navigate('/repo/alpha');
		await settle();
		vi.mocked(browseDirectory).mockReturnValueOnce(stale.promise);
		field.replaceServingInstance('instance-2');
		expect(field.browser.listing.status).toBe('loading');
		const staleSignal = vi.mocked(browseDirectory).mock.calls.at(-1)?.[1];

		field.switchExecutor('22222222-2222-4222-8222-222222222222', 'worker-1');
		field.type('/repo');
		await settle();
		expect(staleSignal?.aborted).toBe(true);
		expect(vi.mocked(browseDirectory).mock.calls.at(-1)).toEqual([
			'/repo',
			expect.any(AbortSignal),
			'22222222-2222-4222-8222-222222222222',
		]);
		stale.resolve([{ name: 'stale', path: '/repo/alpha/stale', type: 'directory' }]);
		await settle();
		expect(names(field)).toEqual(['alpha', 'alpha-two', 'beta']);
	});
});

describe('DirectoryBrowserState confirming a selection', () => {
	it('opens the field directory itself and selects only on confirmation', async () => {
		const sheet = open({ currentPath: '/repo/alpha', confirmsSelection: true });
		expect(sheet.browser.canConfirm).toBe(false);
		await settle();
		expect(sheet.browser.directory).toBe('/repo/alpha');
		expect(names(sheet)).toEqual(['alpine', 'nested']);
		// A directory reached from a listing exists, so it is selectable while it loads.
		sheet.browser.navigate('/repo/alpha/nested');
		expect(sheet.browser.listing.status).toBe('loading');
		expect(names(sheet)).toEqual([]);
		expect(sheet.browser.canConfirm).toBe(true);
		await settle();
		sheet.browser.navigate('/repo');
		await settle();
		expect(sheet.selections).toEqual([]);
		expect(sheet.currentPath).toBe('/repo/alpha');

		sheet.browser.navigate('/repo/beta');
		await settle();
		sheet.browser.confirm();
		expect(sheet.selections).toEqual(['/repo/beta']);
		expect(sheet.closes).toBe(1);
	});

	it('opens the nearest listable ancestor of a path that names no directory', async () => {
		const sheet = open({ currentPath: '/repo/alpha/gone/deeper', confirmsSelection: true });
		await Promise.resolve();
		flushSync();
		expect(sheet.browser.listing.status).toBe('loading');
		expect(sheet.browser.canConfirm).toBe(false);
		await settle();
		expect(browsedPaths()).toEqual(['/repo/alpha/gone/deeper', '/repo/alpha/gone', '/repo/alpha']);
		expect(sheet.browser.directory).toBe('/repo/alpha');
		expect(sheet.browser.listing.status).toBe('ready');
		expect(sheet.browser.filter).toBe('gone');
		expect(names(sheet)).toEqual([]);
		expect(sheet.browser.suggestedName).toBe('gone');
		sheet.browser.filter = '';
		expect(names(sheet)).toEqual(['alpine', 'nested']);
	});

	it('opens the base after a bounded number of listings when a deep path is missing', async () => {
		const segments = Array.from({ length: 2000 }, (_, index) => `s${index}`);
		const sheet = open({ currentPath: `/repo/${segments.join('/')}`, confirmsSelection: true });
		for (let turn = 0; turn < 8; turn += 1) await settle();
		expect(browsedPaths()).toEqual([
			`/repo/${segments.join('/')}`,
			`/repo/${segments.slice(0, -1).join('/')}`,
			`/repo/${segments.slice(0, -2).join('/')}`,
			`/repo/${segments.slice(0, -3).join('/')}`,
			'/repo',
		]);
		expect(sheet.browser.directory).toBe('/repo');
		expect(sheet.browser.filter).toBe('');
		expect(names(sheet)).toEqual(['alpha', 'alpha-two', 'beta']);
		expect(sheet.browser.canConfirm).toBe(true);
	});

	it('reports a base it cannot list instead of looking further', async () => {
		directories.delete('/repo');
		const sheet = open({ currentPath: '/repo/a/b/c/d/e', confirmsSelection: true });
		for (let turn = 0; turn < 8; turn += 1) await settle();
		expect(browsedPaths()).toHaveLength(5);
		expect(sheet.browser.directory).toBe('/repo');
		expect(sheet.browser.listing.status).toBe('error');
	});

	it('opens the directory of a path that names a file without offering to create it', async () => {
		vi.mocked(browseDirectory).mockImplementation(async (path) => {
			if (path === '/repo/alpha/README.md') {
				throw new ApiError(400, 'File tree path must identify a directory', 'FILE_DIRECTORY_REQUIRED');
			}
			return entries(path);
		});
		const sheet = open({ currentPath: '/repo/alpha/README.md', confirmsSelection: true });
		await settle();
		expect(sheet.browser.directory).toBe('/repo/alpha');
		expect(sheet.browser.filter).toBe('');
		expect(sheet.browser.suggestedName).toBeNull();
		expect(names(sheet)).toEqual(['alpine', 'nested']);
	});

	it('treats only a directory reached from a listing on this executor as known while it loads', async () => {
		const held = Promise.withResolvers<DirectoryEntry[]>();
		const sheet = open({ currentPath: '/repo', confirmsSelection: true });
		await settle();
		sheet.browser.navigate('/repo/alpha');
		await settle();
		vi.mocked(browseDirectory).mockReturnValue(held.promise);
		sheet.switchExecutor('22222222-2222-4222-8222-222222222222', 'worker-1');
		expect(sheet.browser.listing.status).toBe('loading');
		expect(sheet.browser.canConfirm).toBe(false);
		expect(sheet.browser.canCreate).toBe(false);

		const field = open({ currentPath: '/repo' });
		field.browser.navigate('/repo/alpha');
		expect(field.browser.canCreate).toBe(true);
		field.type('/repo/unlisted/');
		expect(field.browser.listing.status).toBe('loading');
		expect(field.browser.canCreate).toBe(false);
		field.browser.startCreation('child');
		expect(field.browser.creation).toBeNull();
	});

	it('reports a directory it cannot list and retries it', async () => {
		vi.mocked(browseDirectory).mockRejectedValueOnce(
			new ApiError(403, 'Permission denied', 'FILE_PERMISSION_DENIED'),
		);
		const sheet = open({ currentPath: '/repo/alpha', confirmsSelection: true });
		await settle();
		expect(sheet.browser.listing).toEqual({ status: 'error', message: 'Permission denied' });
		expect(sheet.browser.directory).toBe('/repo/alpha');
		expect(sheet.browser.canConfirm).toBe(false);
		expect(sheet.browser.canCreate).toBe(false);
		sheet.browser.startCreation();
		expect(sheet.browser.creation).toBeNull();
		sheet.browser.reload();
		await settle();
		expect(names(sheet)).toEqual(['alpine', 'nested']);
		expect(sheet.browser.canConfirm).toBe(true);
	});

	it('does not leave a directory the user navigated to when it fails to list', async () => {
		const sheet = open({ currentPath: '/repo', confirmsSelection: true });
		await settle();
		directories.delete('/repo/beta');
		sheet.browser.navigate('/repo/beta');
		await settle();
		expect(sheet.browser.directory).toBe('/repo/beta');
		expect(sheet.browser.listing.status).toBe('error');
	});

	it('matches its filter anywhere in a name and keeps it to one directory', async () => {
		const sheet = open({ currentPath: '/repo', confirmsSelection: true });
		await settle();
		sheet.browser.filter = ' TWO ';
		expect(names(sheet)).toEqual(['alpha-two']);
		expect(sheet.browser.query).toBe('TWO');
		sheet.browser.navigate('/repo/alpha');
		await settle();
		expect(sheet.browser.filter).toBe('');
		expect(names(sheet)).toEqual(['alpine', 'nested']);
		sheet.browser.filter = 'nest';
		sheet.replaceServingInstance('instance-2');
		await settle();
		expect(sheet.browser.filter).toBe('nest');
		expect(names(sheet)).toEqual(['nested']);
	});
});

describe('DirectoryBrowserState creating a directory', () => {
	it('creates the trimmed name in the listed directory and enters it', async () => {
		const sheet = open({ currentPath: '/repo/alpha', confirmsSelection: true });
		await settle();
		sheet.browser.startCreation();
		sheet.browser.creationName = '  fresh  ';
		expect(sheet.browser.canSubmitCreation).toBe(true);
		const submitted = sheet.browser.submitCreation();
		expect(sheet.browser.creation).toMatchObject({ submitting: true });
		expect(sheet.browser.canSubmitCreation).toBe(false);
		expect(await submitted).toBe(true);
		await settle();
		expect(createDirectory).toHaveBeenCalledExactlyOnceWith({
			executorId: 'local',
			parentPath: '/repo/alpha',
			name: 'fresh',
		});
		expect(sheet.browser.creation).toBeNull();
		expect(sheet.browser.directory).toBe('/repo/alpha/fresh');
		expect(sheet.browser.listing).toEqual({ status: 'ready', entries: [] });
		expect(sheet.selections).toEqual([]);
		sheet.browser.confirm();
		expect(sheet.selections).toEqual(['/repo/alpha/fresh']);
	});

	it('publishes a created directory to a field that follows navigation', async () => {
		const field = open({ currentPath: '/repo/fre' });
		await settle();
		expect(field.browser.suggestedName).toBe('fre');
		field.browser.startCreation(field.browser.suggestedName ?? '');
		expect(field.browser.suggestedName).toBeNull();
		field.browser.creationName = 'fresh';
		expect(await field.browser.submitCreation()).toBe(true);
		await settle();
		expect(field.selections).toEqual(['/repo/fresh']);
		expect(field.browser.directory).toBe('/repo/fresh');
	});

	it('explains names that cannot be created without sending them', async () => {
		const sheet = open({ currentPath: '/repo', confirmsSelection: true });
		await settle();
		sheet.browser.startCreation();
		expect(sheet.browser.creationError).toBeNull();
		for (const [name, message] of [
			['   ', null],
			['..', 'That name is reserved.'],
			['a/b', 'Names cannot contain slashes or control characters.'],
			['x'.repeat(256), 'That name is too long.'],
		] as const) {
			sheet.browser.creationName = name;
			expect(sheet.browser.creationError).toBe(message);
			expect(sheet.browser.canSubmitCreation).toBe(false);
			expect(await sheet.browser.submitCreation()).toBe(false);
		}
		expect(createDirectory).not.toHaveBeenCalled();
	});

	it('keeps the form and rereads the list after a rejected or unconfirmed creation', async () => {
		const sheet = open({ currentPath: '/repo', confirmsSelection: true });
		await settle();
		sheet.browser.startCreation('beta');
		expect(await sheet.browser.submitCreation()).toBe(false);
		await settle();
		expect(sheet.browser.creation).toMatchObject({
			name: 'beta',
			submitting: false,
			error: '"beta" already exists here.',
		});
		expect(sheet.browser.directory).toBe('/repo');
		expect(browsedPaths()).toEqual(['/repo', '/repo']);
		sheet.browser.creationName = 'gamma';
		expect(sheet.browser.creationError).toBeNull();

		vi.mocked(createDirectory).mockImplementationOnce(async ({ parentPath, name }) => {
			directories.set(parentPath, [...(directories.get(parentPath) ?? []), name]);
			throw new ApiMutationOutcomeUnknownError('unconfirmed');
		});
		expect(await sheet.browser.submitCreation()).toBe(false);
		await settle();
		expect(sheet.browser.creationError).toBe(
			'Could not confirm the directory was created. Check the list before trying again.',
		);
		expect(sheet.browser.listing.status).toBe('ready');
		expect(names(sheet)).toEqual(['alpha', 'alpha-two', 'beta', 'gamma']);

		// A definite refusal cannot have changed the directory, so it is not read again.
		const listings = browsedPaths().length;
		vi.mocked(createDirectory).mockRejectedValueOnce(
			new ApiError(403, 'Permission denied', 'FILE_PERMISSION_DENIED'),
		);
		sheet.browser.creationName = 'delta';
		expect(await sheet.browser.submitCreation()).toBe(false);
		await settle();
		expect(sheet.browser.creationError).toBe('Permission denied');
		expect(browsedPaths()).toHaveLength(listings);
		expect(createDirectory).toHaveBeenCalledTimes(3);
	});

	it('keeps the form with the directory it was opened in', async () => {
		const field = open({ currentPath: '/repo/' });
		await settle();
		field.browser.startCreation('fresh');
		field.type('/repo/alpha/');
		await settle();
		expect(field.browser.creation).toBeNull();
		expect(field.browser.creationName).toBe('');
		expect(field.browser.canSubmitCreation).toBe(false);
		expect(await field.browser.submitCreation()).toBe(false);
		field.type('/repo/');
		expect(field.browser.creation).toMatchObject({ name: 'fresh', submitting: false });
		field.browser.navigate('/repo/alpha');
		field.type('/repo/');
		expect(field.browser.creation).toBeNull();
		expect(createDirectory).not.toHaveBeenCalled();
	});

	it('does not move a browser that left the directory before its creation settled', async () => {
		const pending = Promise.withResolvers<{ name: string; path: string; type: 'directory' }>();
		vi.mocked(createDirectory).mockReturnValueOnce(pending.promise);
		const sheet = open({ currentPath: '/repo', confirmsSelection: true });
		await settle();
		sheet.browser.startCreation('fresh');
		const submitted = sheet.browser.submitCreation();
		sheet.browser.navigate('/repo/alpha');
		await settle();
		expect(sheet.browser.creation).toBeNull();
		pending.resolve({ name: 'fresh', path: '/repo/fresh', type: 'directory' });
		expect(await submitted).toBe(false);
		await settle();
		expect(sheet.browser.directory).toBe('/repo/alpha');
		expect(sheet.selections).toEqual([]);
	});

	it('rereads the list when a cancelled creation settles in the directory on screen', async () => {
		const pending = Promise.withResolvers<{ name: string; path: string; type: 'directory' }>();
		vi.mocked(createDirectory).mockImplementationOnce(async ({ parentPath, name }) => {
			directories.set(parentPath, [...(directories.get(parentPath) ?? []), name]);
			return pending.promise;
		});
		const sheet = open({ currentPath: '/repo', confirmsSelection: true });
		await settle();
		sheet.browser.startCreation('fresh');
		const submitted = sheet.browser.submitCreation();
		sheet.browser.cancelCreation();
		expect(sheet.browser.creation).toBeNull();
		sheet.browser.startCreation('other');
		pending.resolve({ name: 'fresh', path: '/repo/fresh', type: 'directory' });
		expect(await submitted).toBe(false);
		await settle();
		expect(sheet.browser.directory).toBe('/repo');
		expect(sheet.browser.creation).toMatchObject({ name: 'other', submitting: false });
		expect(names(sheet)).toEqual(['alpha', 'alpha-two', 'beta', 'fresh']);
	});

	it('clears a form whose field retargeted the browser while it was creating', async () => {
		const pending = Promise.withResolvers<{ name: string; path: string; type: 'directory' }>();
		vi.mocked(createDirectory).mockReturnValueOnce(pending.promise);
		const field = open({ currentPath: '/repo/' });
		await settle();
		field.browser.startCreation('fresh');
		const submitted = field.browser.submitCreation();
		field.type('/repo/alpha/');
		await settle();
		pending.resolve({ name: 'fresh', path: '/repo/fresh', type: 'directory' });
		expect(await submitted).toBe(false);
		expect(field.browser.creation).toBeNull();
		expect(field.browser.directory).toBe('/repo/alpha');
		expect(field.selections).toEqual([]);
	});

	it('shows a created directory in place when its reported path is outside the base', async () => {
		vi.mocked(createDirectory).mockImplementationOnce(async ({ parentPath, name }) => {
			directories.set(parentPath, [...(directories.get(parentPath) ?? []), name]);
			return { name, path: `/private/repo/${name}`, type: 'directory' };
		});
		const field = open({ currentPath: '/repo/' });
		await settle();
		field.browser.startCreation('fresh');
		expect(await field.browser.submitCreation()).toBe(false);
		await settle();
		expect(field.browser.creation).toBeNull();
		expect(field.browser.directory).toBe('/repo');
		expect(field.selections).toEqual([]);
		expect(names(field)).toEqual(['alpha', 'alpha-two', 'beta', 'fresh']);
	});

	it('neither selects nor moves once disposed while a creation is in flight', async () => {
		const pending = Promise.withResolvers<{ name: string; path: string; type: 'directory' }>();
		const rejected = Promise.withResolvers<{ name: string; path: string; type: 'directory' }>();
		vi.mocked(createDirectory).mockReturnValueOnce(pending.promise).mockReturnValueOnce(rejected.promise);
		for (const outcome of [pending, rejected]) {
			const field = open({ currentPath: '/repo/' });
			await settle();
			field.browser.startCreation('fresh');
			const submitted = field.browser.submitCreation();
			field.dispose();
			field.browser.dispose();
			if (outcome === pending) outcome.resolve({ name: 'fresh', path: '/repo/fresh', type: 'directory' });
			else outcome.reject(new ApiError(409, 'Exists', 'FILE_ALREADY_EXISTS'));
			expect(await submitted).toBe(false);
			expect(field.selections).toEqual([]);
			expect(field.browser.directory).toBe('/repo');
			expect(field.browser.creation).toBeNull();
		}
	});

	it('offers and starts no creation on an executor that cannot create directories', async () => {
		const sheet = open({ currentPath: '/repo', confirmsSelection: true, supportsCreation: false });
		await settle();
		expect(sheet.browser.canConfirm).toBe(true);
		expect(sheet.browser.canCreate).toBe(false);
		sheet.browser.filter = 'fresh';
		expect(sheet.browser.suggestedName).toBeNull();
		sheet.browser.startCreation('fresh');
		expect(sheet.browser.creation).toBeNull();
		expect(await sheet.browser.submitCreation()).toBe(false);
		expect(createDirectory).not.toHaveBeenCalled();
	});

	it('suggests only a creatable name that no listed directory has', async () => {
		const sheet = open({ currentPath: '/repo', confirmsSelection: true });
		expect(sheet.browser.suggestedName).toBeNull();
		await settle();
		expect(sheet.browser.suggestedName).toBeNull();
		for (const [filter, suggestion] of [
			['alp', 'alp'],
			['alpha', null],
			['Alpha', 'Alpha'],
			['a/b', null],
			['..', null],
		] as const) {
			sheet.browser.filter = filter;
			expect(sheet.browser.suggestedName).toBe(suggestion);
		}
	});
});
