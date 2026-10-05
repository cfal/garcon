import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import { browseDirectory, createDirectory } from '$lib/api/files';
import DirectoryBrowserTestHost from '$lib/components/project-paths/__tests__/DirectoryBrowserTestHost.svelte';

vi.mock('$lib/api/files', () => ({ browseDirectory: vi.fn(), createDirectory: vi.fn() }));

const tree: Record<string, string[]> = {
	'/repo': ['alpha', 'beta'],
	'/repo/alpha': ['alpine', 'nested'],
	'/repo/alpha/nested': [],
	'/repo/alpha/fresh': [],
	'/repo/beta': [],
};

function browseTree(): void {
	vi.mocked(browseDirectory).mockImplementation(async (path) => {
		const names = tree[path];
		if (!names) throw new ApiError(404, 'File or directory not found', 'FILE_NOT_FOUND');
		return names.map((name) => ({ name, path: `${path}/${name}`, type: 'directory' }));
	});
}

// Renders a browser whose field applies each selection, as the path forms do.
function renderBrowser(options: { currentPath: string; isMobile: boolean }) {
	const onSelect = vi.fn((path: string) => void view.rerender({ currentPath: path }));
	const onClose = vi.fn();
	const view = render(DirectoryBrowserTestHost, {
		executorId: 'local',
		executorContextKey: 'instance-1',
		basePath: '/repo',
		onSelect,
		onClose,
		...options,
	});
	return { view, onSelect, onClose };
}

function rowNames(): string[] {
	return within(screen.getByRole('list'))
		.getAllByRole('button')
		.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '');
}

afterEach(() => vi.resetAllMocks());

it('keeps trailing spaces when filtering directory names', async () => {
	vi.mocked(browseDirectory).mockReset().mockResolvedValue([
		{ name: 'project', path: '/repo/project', type: 'directory' },
		{ name: 'project ', path: '/repo/project ', type: 'directory' },
	]);
	const view = render(DirectoryBrowserTestHost, {
		executorId: 'local', currentPath: '/repo/project ', basePath: '/repo', isMobile: false, onSelect: vi.fn(), onClose: vi.fn(),
	});
	await waitFor(() => expect(view.getAllByRole('button', { name: 'project' })).toHaveLength(1));
	view.unmount();
});

it('reloads a directory after a same-path serving-instance change and rejects late results', async () => {
	const stale = Promise.withResolvers<Awaited<ReturnType<typeof browseDirectory>>>();
	vi.mocked(browseDirectory).mockReturnValueOnce(stale.promise).mockResolvedValueOnce([
		{ name: 'current', path: '/repo/current', type: 'directory' },
	]);
	const view = render(DirectoryBrowserTestHost, {
		executorId: '22222222-2222-4222-8222-222222222222', executorContextKey: 'old',
		currentPath: '/repo/', basePath: '/repo', isMobile: false, onSelect: vi.fn(), onClose: vi.fn(),
	});
	await waitFor(() => expect(browseDirectory).toHaveBeenCalledOnce());
	const signal = vi.mocked(browseDirectory).mock.calls[0][1];
	await view.rerender({ executorContextKey: 'new' });
	expect(await screen.findByRole('button', { name: 'current' })).toBeTruthy();
	expect(signal?.aborted).toBe(true);
	stale.resolve([{ name: 'stale', path: '/repo/stale', type: 'directory' }]);
	await tick();
	expect(screen.queryByRole('button', { name: 'stale' })).toBeNull();
});

it('derives typed prefixes without refetching the same parent', async () => {
	vi.mocked(browseDirectory).mockResolvedValue([
		{ name: 'alpha-one', path: '/repo/alpha-one', type: 'directory' },
		{ name: 'alpha-two', path: '/repo/alpha-two', type: 'directory' },
	]);
	const view = render(DirectoryBrowserTestHost, {
		executorId: 'local', currentPath: '/repo/a', basePath: '/repo', isMobile: false, onSelect: vi.fn(), onClose: vi.fn(),
	});
	await screen.findByRole('button', { name: 'alpha-one' });
	await view.rerender({ currentPath: '/repo/alpha-t' });
	expect(screen.queryByRole('button', { name: 'alpha-one' })).toBeNull();
	expect(screen.getByRole('button', { name: 'alpha-two' })).toBeTruthy();
	expect(browseDirectory).toHaveBeenCalledOnce();
});

describe.each([{ isMobile: false }, { isMobile: true }])('directory browser (mobile: $isMobile)', ({ isMobile }) => {
	it('lists every child of a directory it opens', async () => {
		browseTree();
		const { onSelect } = renderBrowser({ currentPath: '/repo', isMobile });
		await fireEvent.click(await screen.findByRole('button', { name: 'alpha' }));
		await screen.findByRole('button', { name: 'nested' });
		expect(rowNames()).toEqual(['Parent directory', 'alpine', 'nested']);
		await fireEvent.click(screen.getByRole('button', { name: 'nested' }));
		await screen.findByText('No subdirectories');
		expect(rowNames()).toEqual(['Parent directory']);
		expect(screen.getByRole('button', { name: 'nested' }).getAttribute('aria-current')).toBe('location');
		await fireEvent.click(screen.getByRole('button', { name: 'Parent directory' }));
		await screen.findByRole('button', { name: 'alpine' });
		expect(onSelect.mock.calls.map(([path]) => path)).toEqual(
			isMobile ? [] : ['/repo/alpha', '/repo/alpha/nested', '/repo/alpha'],
		);
	});

	it('moves focus between rows with the arrow keys', async () => {
		browseTree();
		renderBrowser({ currentPath: '/repo/alpha/', isMobile });
		const first = await screen.findByRole('button', { name: 'Parent directory' });
		first.focus();
		await fireEvent.keyDown(first, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'alpine' }));
		await fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
		await fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'nested' }));
		await fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'alpine' }));
	});

	it('creates a directory, enters it, and reports a name that exists', async () => {
		browseTree();
		vi.mocked(createDirectory)
			.mockRejectedValueOnce(new ApiError(409, 'Exists', 'FILE_ALREADY_EXISTS'))
			.mockResolvedValueOnce({ name: 'fresh', path: '/repo/alpha/fresh', type: 'directory' });
		const { onSelect, onClose } = renderBrowser({ currentPath: '/repo/alpha/', isMobile });
		await screen.findByRole('button', { name: 'nested' });
		await fireEvent.click(screen.getByRole('button', { name: 'New directory' }));
		const name = screen.getByRole<HTMLInputElement>('textbox', { name: 'Directory name' });
		await waitFor(() => expect(document.activeElement).toBe(name));
		const create = screen.getByRole<HTMLButtonElement>('button', { name: 'Create' });
		expect(create.disabled).toBe(true);
		await fireEvent.input(name, { target: { value: 'a/b' } });
		expect(screen.getByRole('alert').textContent).toContain('Names cannot contain slashes');
		expect(name.getAttribute('aria-invalid')).toBe('true');
		expect(create.disabled).toBe(true);

		await fireEvent.input(name, { target: { value: 'nested' } });
		expect(screen.queryByRole('alert')).toBeNull();
		await fireEvent.click(create);
		expect((await screen.findByRole('alert')).textContent).toContain('"nested" already exists here.');
		expect(name.value).toBe('nested');
		expect(browseDirectory).toHaveBeenCalledTimes(2);

		await fireEvent.input(name, { target: { value: 'fresh' } });
		await fireEvent.click(create);
		await screen.findByText('No subdirectories');
		expect(createDirectory).toHaveBeenLastCalledWith({ executorId: 'local', parentPath: '/repo/alpha', name: 'fresh' });
		expect(screen.queryByRole('textbox', { name: 'Directory name' })).toBeNull();
		expect(screen.getByRole('button', { name: 'fresh' }).getAttribute('aria-current')).toBe('location');
		expect(onSelect.mock.calls.map(([path]) => path)).toEqual(isMobile ? [] : ['/repo/alpha/fresh']);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('backs out of the creation form before closing', async () => {
		browseTree();
		const { onClose } = renderBrowser({ currentPath: '/repo', isMobile });
		const opener = await screen.findByRole('button', { name: 'New directory' });
		await waitFor(() => expect(opener).toHaveProperty('disabled', false));
		await fireEvent.click(opener);
		await fireEvent.keyDown(screen.getByRole('textbox', { name: 'Directory name' }), { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Directory name' })).toBeNull());
		expect(onClose).not.toHaveBeenCalled();
		await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
	});
});

it('ignores a creation that settles after the popover closed', async () => {
	browseTree();
	const pending = Promise.withResolvers<{ name: string; path: string; type: 'directory' }>();
	vi.mocked(createDirectory).mockReturnValueOnce(pending.promise);
	const opener = document.createElement('button');
	document.body.append(opener);
	opener.focus();
	const { view, onSelect } = renderBrowser({ currentPath: '/repo/', isMobile: false });
	await screen.findByRole('button', { name: 'alpha' });
	await fireEvent.click(screen.getByRole('button', { name: 'New directory' }));
	const name = screen.getByRole('textbox', { name: 'Directory name' });
	await fireEvent.input(name, { target: { value: 'fresh' } });
	await fireEvent.keyDown(name, { key: 'Enter' });
	expect(createDirectory).toHaveBeenCalledOnce();
	view.unmount();
	document.body.focus();
	opener.blur();
	pending.resolve({ name: 'fresh', path: '/repo/fresh', type: 'directory' });
	await tick();
	await tick();
	expect(onSelect).not.toHaveBeenCalled();
	expect(document.activeElement).not.toBe(opener);
	opener.remove();
});

it.each([{ isMobile: false }, { isMobile: true }])(
	'offers no creation on an executor that cannot create directories (mobile: $isMobile)',
	async ({ isMobile }) => {
		browseTree();
		render(DirectoryBrowserTestHost, {
			executorId: 'local',
			executorContextKey: 'instance-1',
			basePath: '/repo',
			currentPath: isMobile ? '/repo/alpha/missing' : '/repo/alpha/missing-',
			isMobile,
			localDirectoryCreation: false,
			onSelect: vi.fn(),
			onClose: vi.fn(),
		});
		expect(await screen.findByText(/No directories match "missing/)).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'New directory' })).toBeNull();
		expect(screen.queryByRole('button', { name: /Create directory/ })).toBeNull();
		expect(createDirectory).not.toHaveBeenCalled();
	},
);

describe('mobile directory sheet', () => {
	it('opens on the field directory and selects only when confirmed', async () => {
		browseTree();
		const { onSelect, onClose } = renderBrowser({ currentPath: '/repo/alpha', isMobile: true });
		await screen.findByRole('button', { name: 'nested' });
		expect(browseDirectory).toHaveBeenCalledExactlyOnceWith('/repo/alpha', expect.any(AbortSignal), 'local');
		await fireEvent.click(screen.getByRole('button', { name: 'repo' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'beta' }));
		await screen.findByText('No subdirectories');
		expect(onSelect).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Select this directory' }));
		expect(onSelect).toHaveBeenCalledExactlyOnceWith('/repo/beta');
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('closes without changing the field', async () => {
		browseTree();
		const { onSelect, onClose } = renderBrowser({ currentPath: '/repo', isMobile: true });
		await fireEvent.click(await screen.findByRole('button', { name: 'alpha' }));
		await screen.findByRole('button', { name: 'nested' });
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onSelect).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('opens the nearest directory of a missing path and offers to create it', async () => {
		browseTree();
		renderBrowser({ currentPath: '/repo/alpha/missing', isMobile: true });
		const filter = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Filter directories...' });
		await waitFor(() => expect(filter.value).toBe('missing'));
		expect(screen.getByText('No directories match "missing"')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Create directory "missing"' }));
		const name = screen.getByRole<HTMLInputElement>('textbox', { name: 'Directory name' });
		expect(name.value).toBe('missing');
		expect(screen.getByText('New directory in alpha')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Cancel' }).textContent?.trim()).toBe('Cancel');
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel new directory' }));
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New directory' })));
		await fireEvent.click(screen.getByRole('button', { name: 'New directory' }));
		await fireEvent.keyDown(screen.getByRole('textbox', { name: 'Directory name' }), { key: 'Escape' });
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New directory' })));
		await fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
		expect(rowNames()).toEqual(['Parent directory', 'alpine', 'nested']);
	});

	it('reports a directory that cannot be listed and retries it', async () => {
		vi.mocked(browseDirectory)
			.mockRejectedValueOnce(new ApiError(403, 'Permission denied', 'FILE_PERMISSION_DENIED'))
			.mockResolvedValue([{ name: 'alpha', path: '/repo/alpha', type: 'directory' }]);
		renderBrowser({ currentPath: '/repo', isMobile: true });
		expect((await screen.findByRole('alert')).textContent).toContain('Permission denied');
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Select this directory' }).disabled).toBe(true);
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'New directory' }).disabled).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		await screen.findByRole('button', { name: 'alpha' });
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Select this directory' }).disabled).toBe(false);
	});
});
