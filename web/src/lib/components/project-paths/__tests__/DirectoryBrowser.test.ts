import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { expect, it, vi } from 'vitest';
import { browseDirectory } from '$lib/api/files';
import DirectoryBrowserTestHost from '$lib/components/project-paths/__tests__/DirectoryBrowserTestHost.svelte';

vi.mock('$lib/api/files', () => ({ browseDirectory: vi.fn() }));

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

it('derives typed prefixes without refetching or clearing the mobile filter for the same parent', async () => {
	vi.mocked(browseDirectory).mockReset().mockResolvedValue([
		{ name: 'alpha-one', path: '/repo/alpha-one', type: 'directory' },
		{ name: 'alpha-two', path: '/repo/alpha-two', type: 'directory' },
	]);
	const view = render(DirectoryBrowserTestHost, {
		executorId: 'local', currentPath: '/repo/a', basePath: '/repo', isMobile: true, onSelect: vi.fn(), onClose: vi.fn(),
	});
	await screen.findByRole('button', { name: 'alpha-one' });
	const filter = screen.getByRole('textbox');
	await fireEvent.input(filter, { target: { value: 'one' } });
	expect(filter).toHaveProperty('value', 'one');
	await view.rerender({ currentPath: '/repo/alpha' });
	expect(filter).toHaveProperty('value', 'one');
	expect(screen.queryByRole('button', { name: 'alpha-two' })).toBeNull();
	expect(browseDirectory).toHaveBeenCalledOnce();
});
