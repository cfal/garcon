import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as filesApi from '$lib/api/files.js';
import { FileImageCache } from '$lib/files/images/file-image-cache.svelte.js';
import type { ResolveMarkdownImageFile } from '$lib/chat/file-links/file-link-resolver.js';
import Host from './MarkdownImageCacheHost.svelte';

const resolveImageFile: ResolveMarkdownImageFile = () => ({
	executorId: 'worker',
	executorContextKey: 'instance-1',
	projectPath: '/workspace',
	filePath: 'capture.png',
});

describe('shared Markdown image cache', () => {
	let cache: FileImageCache;
	beforeEach(() => {
		vi.stubGlobal('IntersectionObserver', undefined);
		let id = 0;
		vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:cached-${++id}`);
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		vi.spyOn(filesApi, 'readContent').mockResolvedValue({
			blob: new Blob(['synthetic'], { type: 'image/png' }),
			revision: 'v1:first',
		});
		cache = new FileImageCache({ budgetBytes: 64 * 1024 * 1024 });
	});
	afterEach(() => {
		cleanup();
		cache.destroy();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('restores the same image URL without a loading indicator or request on remount', async () => {
		const props = { cache, source: '![Capture](capture.png)', resolveImageFile };
		const first = render(Host, props);
		await screen.findByRole('img', { name: 'Capture' });
		first.unmount();
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		render(Host, props);
		await tick();
		expect(screen.getByRole('img').getAttribute('src')).toBe('blob:cached-1');
		expect(screen.queryByRole('status')).toBeNull();
		expect(filesApi.readContent).toHaveBeenCalledOnce();
	});

	it('shares images between Markdown surfaces without revoking an active consumer', async () => {
		const first = render(Host, { cache, source: '![First](capture.png)', resolveImageFile });
		render(Host, { cache, source: '![Second](capture.png)', resolveImageFile });
		await screen.findByRole('img', { name: 'Second' });
		first.unmount();
		cache.setIdleBudget(0);
		expect(screen.getByRole('img').getAttribute('src')).toBe('blob:cached-1');
		expect(filesApi.readContent).toHaveBeenCalledOnce();
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
	});

	it('invalidates mounted leases on logout and reacquires for the new owner', async () => {
		cache.setOwner('user:first');
		render(Host, { cache, source: '![Capture](capture.png)', resolveImageFile });
		await screen.findByRole('img');
		cache.setOwner(null);
		await tick();
		expect(screen.getByText('Unable to load image')).toBeTruthy();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:cached-1');
		cache.setOwner('user:second');
		await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:cached-2'));
		expect(filesApi.readContent).toHaveBeenCalledTimes(2);
	});

	it('does not share a completed image across executor incarnations', async () => {
		const view = render(Host, { cache, source: '![Capture](capture.png)', resolveImageFile });
		await screen.findByRole('img');
		await view.rerender({
			resolveImageFile: () => ({ ...resolveImageFile('')!, executorContextKey: 'instance-2' }),
		});
		await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:cached-2'));
		expect(filesApi.readContent).toHaveBeenCalledTimes(2);
	});

	it('ignores errors from a detached image while its replacement loads and after publication', async () => {
		render(Host, { cache, source: '![Capture](capture.png)', resolveImageFile });
		const previous = await screen.findByRole('img');
		const pending = Promise.withResolvers<Awaited<ReturnType<typeof filesApi.readContent>>>();
		vi.mocked(filesApi.readContent).mockReturnValueOnce(pending.promise);
		cache.clear();
		await tick();
		expect(previous.isConnected).toBe(false);
		previous.dispatchEvent(new Event('error'));
		await tick();
		expect(screen.queryByText('Unable to load image')).toBeNull();
		expect(vi.mocked(filesApi.readContent).mock.calls[1][1]?.signal?.aborted).toBe(false);
		pending.resolve({
			blob: new Blob(['replacement'], { type: 'image/png' }),
			revision: 'v1:next',
		});
		await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:cached-2'));
		previous.dispatchEvent(new Event('error'));
		await tick();
		expect(screen.getByRole('img').getAttribute('src')).toBe('blob:cached-2');
	});
});
