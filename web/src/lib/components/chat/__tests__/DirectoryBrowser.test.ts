import { render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { expect, it, vi } from 'vitest';
import { browseDirectory } from '$lib/api/files';
import DirectoryBrowserTestHost from './DirectoryBrowserTestHost.svelte';

vi.mock('$lib/api/files', () => ({ browseDirectory: vi.fn() }));

it('reloads a directory after a same-path serving-instance change and rejects late results', async () => {
	const stale = Promise.withResolvers<Awaited<ReturnType<typeof browseDirectory>>>();
	vi.mocked(browseDirectory).mockReturnValueOnce(stale.promise).mockResolvedValueOnce([
		{ name: 'current', path: '/repo/current', type: 'directory' },
	]);
	const view = render(DirectoryBrowserTestHost, {
		nodeId: '22222222-2222-4222-8222-222222222222', nodeContextKey: 'old',
		currentPath: '/repo/', basePath: '/repo', isMobile: false, onSelect: vi.fn(), onClose: vi.fn(),
	});
	await waitFor(() => expect(browseDirectory).toHaveBeenCalledOnce());
	const signal = vi.mocked(browseDirectory).mock.calls[0][1];
	await view.rerender({ nodeContextKey: 'new' });
	expect(await screen.findByRole('button', { name: 'current' })).toBeTruthy();
	expect(signal?.aborted).toBe(true);
	stale.resolve([{ name: 'stale', path: '/repo/stale', type: 'directory' }]);
	await tick();
	expect(screen.queryByRole('button', { name: 'stale' })).toBeNull();
});
