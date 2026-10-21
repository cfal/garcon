import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as filesApi from '$lib/api/files.js';
import * as imageDecoder from '$lib/files/images/decode-file-image.js';
import { FileImageCache } from '$lib/files/images/file-image-cache.svelte.js';
import {
	resolveImageFileTarget,
	type ResolveMarkdownImageFile,
} from '$lib/chat/file-links/file-link-resolver.js';
import Markdown from '../Markdown.svelte';
import Host from './MarkdownImageCacheHost.svelte';

const imageResult = {
	blob: new Blob(['synthetic'], { type: 'image/png' }),
	revision: 'v1:synthetic' as const,
};
const resolveImageFile: ResolveMarkdownImageFile = (href) =>
	resolveImageFileTarget(href, {
		executorId: 'worker',
		executorContextKey: 'synthetic-context',
		fileRootPath: '/workspace',
		sourceDirectoryPath: '/workspace/project',
	});

describe('Markdown image recovery', () => {
	beforeEach(() => {
		vi.stubGlobal('IntersectionObserver', undefined);
		let nextUrl = 0;
		vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:retry-${++nextUrl}`);
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		vi.spyOn(filesApi, 'readContent').mockResolvedValue(imageResult);
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('retries a missing image in place, with a themed error row and one request per attempt', async () => {
		vi.mocked(filesApi.readContent).mockRejectedValueOnce(new Error('Not found'));
		const { container } = render(Markdown, { source: '![Capture](capture.png)', resolveImageFile });
		const markdown = container.querySelector('.markdown-body');
		const thumbnail = container.querySelector('.markdown-image');
		const retry = await screen.findByRole('button', { name: 'Retry image Capture' });
		expect(retry.getAttribute('title')).toBe('Retry image Capture');
		const error = container.querySelector('.markdown-image-error')!;
		expect(error.classList.contains('border-status-error-border')).toBe(true);
		expect(error.classList.contains('bg-status-error')).toBe(true);
		expect(screen.queryByRole('alert')).toBeNull();
		const pending = Promise.withResolvers<typeof imageResult>();
		vi.mocked(filesApi.readContent).mockReturnValueOnce(pending.promise);
		retry.click();
		retry.click();
		await tick();
		expect(filesApi.readContent).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole('button')).toBeNull();
		expect(screen.getByRole('status', { name: 'Loading image...' })).toBeTruthy();
		pending.reject(new Error('Still missing'));
		const nextRetry = await screen.findByRole('button', { name: 'Retry image Capture' });
		expect(screen.getByRole('alert').contains(nextRetry)).toBe(true);
		await fireEvent.click(nextRetry);
		expect((await screen.findByRole('img')).getAttribute('src')).toBe('blob:retry-1');
		expect(filesApi.readContent).toHaveBeenCalledTimes(3);
		expect(container.querySelector('.markdown-body')).toBe(markdown);
		expect(container.querySelector('.markdown-image')).toBe(thumbnail);
	});

	it.each([
		'![Capture](capture.png)',
		'[![Capture](capture.png)](guide.md)',
		'[![Capture](capture.png)](C:/workspace/guide.md)',
	])('preserves focus through retries of %s without stealing it back', async (source) => {
		vi.mocked(filesApi.readContent).mockRejectedValueOnce(new Error('Not found'));
		const { container } = render(Markdown, { source, resolveImageFile });
		const pending = Promise.withResolvers<typeof imageResult>();
		const retry = await screen.findByRole('button', { name: 'Retry image Capture' });
		expect(container.querySelector('.markdown-image')?.hasAttribute('tabindex')).toBe(false);
		vi.mocked(filesApi.readContent).mockReturnValueOnce(pending.promise);
		retry.focus();
		await fireEvent.click(retry);
		const focusTarget = container.querySelector('a') ?? container.querySelector('.markdown-image');
		expect(container.querySelector('a [tabindex]')).toBeNull();
		expect(document.activeElement).toBe(focusTarget);
		pending.reject(new Error('Still missing'));
		const nextRetry = await screen.findByRole('button', { name: 'Retry image Capture' });
		expect(document.activeElement).toBe(nextRetry);
		expect(focusTarget?.hasAttribute('tabindex')).toBe(false);
		const nextPending = Promise.withResolvers<typeof imageResult>();
		vi.mocked(filesApi.readContent).mockReturnValueOnce(nextPending.promise);
		await fireEvent.click(nextRetry);
		expect(document.activeElement).toBe(focusTarget);
		const otherControl = document.createElement('button');
		document.body.append(otherControl);
		try {
			otherControl.focus();
			expect(focusTarget?.hasAttribute('tabindex')).toBe(false);
			nextPending.reject(new Error('Still missing'));
			await screen.findByRole('button', { name: 'Retry image Capture' });
			expect(document.activeElement).toBe(otherControl);
		} finally {
			otherControl.remove();
		}
	});

	it.each(['capture.png', 'https://example.com/capture.png'])(
		'does not add a focus stop to a never-failed image at %s',
		async (href) => {
			const { container } = render(Markdown, { source: `![Capture](${href})`, resolveImageFile });
			const thumbnail = container.querySelector('.markdown-image')!;
			expect(thumbnail.hasAttribute('tabindex')).toBe(false);
			await screen.findByRole('img');
			expect(thumbnail.hasAttribute('tabindex')).toBe(false);
		},
	);

	it('retries immediately without waiting for another intersection', async () => {
		const observe = vi.fn();
		const disconnect = vi.fn();
		const observer = {
			root: null,
			rootMargin: '50px',
			scrollMargin: '0px',
			thresholds: [0],
			observe,
			disconnect,
			unobserve: vi.fn(),
			takeRecords: () => [],
		} satisfies IntersectionObserver;
		let intersect!: IntersectionObserverCallback;
		vi.stubGlobal('IntersectionObserver', function (callback: IntersectionObserverCallback) {
			intersect = callback;
			return observer;
		});
		vi.mocked(filesApi.readContent).mockRejectedValueOnce(new Error('Not found'));
		const { container } = render(Markdown, { source: '![Capture](capture.png)', resolveImageFile });
		await tick();
		expect(filesApi.readContent).not.toHaveBeenCalled();
		const target = container.querySelector('.markdown-image')!;
		intersect(
			[
				{
					target,
					isIntersecting: true,
					intersectionRatio: 1,
					time: 0,
					boundingClientRect: target.getBoundingClientRect(),
					intersectionRect: target.getBoundingClientRect(),
					rootBounds: null,
				},
			],
			observer,
		);
		await fireEvent.click(await screen.findByRole('button', { name: 'Retry image Capture' }));
		await screen.findByRole('img');
		expect(filesApi.readContent).toHaveBeenCalledTimes(2);
		expect(observe).toHaveBeenCalledOnce();
		expect(disconnect).toHaveBeenCalledTimes(2);
	});

	it.each(['/outside/capture.png', 'notes.txt'])(
		'offers no retry when the trusted resolver rejects %s',
		async (href) => {
			const resolver = vi.fn(resolveImageFile);
			render(Markdown, { source: `![Capture](${href})`, resolveImageFile: resolver });
			expect(screen.getByText('Unable to load image')).toBeTruthy();
			expect(resolver).toHaveReturnedWith(null);
			expect(screen.queryByRole('button')).toBeNull();
			expect(filesApi.readContent).not.toHaveBeenCalled();
		},
	);

	it.each(['guide.md', 'https://example.com/guide'])(
		'preserves exact text surrounding a link to %s',
		(destination) => {
			const { container } = render(Markdown, {
				source: `See [docs](${destination}).`,
				chatReferencePolicy: 'explicit',
				resolveChatReference: () => ({ title: 'Other chat', isCurrent: false }),
			});
			expect(container.querySelector('.markdown-body > div')?.textContent).toBe('See docs.');
		},
	);

	it.each(['content-type', 'decode'])(
		'recovers from a partial file with a %s failure',
		async (failure) => {
			if (failure === 'decode') {
				vi.spyOn(imageDecoder, 'decodeFileImage').mockRejectedValueOnce(new Error('Partial image'));
			} else {
				vi.mocked(filesApi.readContent).mockResolvedValueOnce({
					...imageResult,
					blob: new Blob(['partial'], { type: 'application/octet-stream' }),
				});
			}
			render(Markdown, { source: '![Capture](capture.png)', resolveImageFile });
			await fireEvent.click(await screen.findByRole('button', { name: 'Retry image Capture' }));
			await screen.findByRole('img');
			expect(filesApi.readContent).toHaveBeenCalledTimes(2);
			if (failure === 'decode') expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:retry-1');
		},
	);

	it.each(['source', 'executorId', 'executorContextKey', 'unmount'])(
		'fences an unfinished retry across %s changes',
		async (change) => {
			vi.mocked(filesApi.readContent).mockRejectedValueOnce(new Error('Not found'));
			const view = render(Markdown, { source: '![Capture](capture.png)', resolveImageFile });
			const retry = await screen.findByRole('button', { name: 'Retry image Capture' });
			const pending = Promise.withResolvers<typeof imageResult>();
			vi.mocked(filesApi.readContent).mockReturnValueOnce(pending.promise);
			await fireEvent.click(retry);
			const signal = vi.mocked(filesApi.readContent).mock.calls[1][1]?.signal;
			if (change === 'unmount') view.unmount();
			else if (change === 'source') await view.rerender({ source: '![Capture](other.png)' });
			else
				await view.rerender({
					resolveImageFile: (href) => ({ ...resolveImageFile(href)!, [change]: 'replacement' }),
				});
			expect(signal?.aborted).toBe(true);
			pending.resolve(imageResult);
			await tick();
			if (change === 'unmount') expect(URL.createObjectURL).not.toHaveBeenCalled();
			else {
				await screen.findByRole('img');
				expect(URL.createObjectURL).toHaveBeenCalledOnce();
			}
		},
	);

	it('ignores detached-image errors before and after retry publication', async () => {
		render(Markdown, { source: '![Capture](capture.png)', resolveImageFile });
		const oldImage = await screen.findByRole('img');
		await fireEvent.error(oldImage);
		const pending = Promise.withResolvers<typeof imageResult>();
		vi.mocked(filesApi.readContent).mockReturnValueOnce(pending.promise);
		await fireEvent.click(screen.getByRole('button', { name: 'Retry image Capture' }));
		await fireEvent.error(oldImage);
		expect(screen.queryByRole('alert')).toBeNull();
		expect(vi.mocked(filesApi.readContent).mock.calls[1][1]?.signal?.aborted).toBe(false);
		pending.resolve(imageResult);
		const replacement = await screen.findByRole('img');
		await fireEvent.error(oldImage);
		expect(screen.getByRole('img')).toBe(replacement);
	});

	it('shares concurrent retries without evicting unrelated active or idle images', async () => {
		const cache = new FileImageCache({ budgetBytes: 64 * 1024 * 1024 });
		try {
			const retained = render(Host, {
				cache,
				source: '![Retained](retained.png)',
				resolveImageFile,
			});
			const retainedUrl = (await screen.findByRole('img')).getAttribute('src');
			retained.unmount();
			vi.mocked(filesApi.readContent).mockImplementation(async ({ filePath }) => {
				if (filePath.endsWith('missing.png')) throw new Error('Not found');
				return imageResult;
			});
			render(Host, {
				cache,
				source: '![Good](good.png) ![First](missing.png) ![Second](missing.png)',
				resolveImageFile,
			});
			const good = await screen.findByRole('img', { name: 'Good' });
			const firstRetry = await screen.findByRole('button', { name: 'Retry image First' });
			const secondRetry = await screen.findByRole('button', { name: 'Retry image Second' });
			const reads = vi.mocked(filesApi.readContent).mock.calls.length;
			const pending = Promise.withResolvers<typeof imageResult>();
			vi.mocked(filesApi.readContent).mockReturnValue(pending.promise);
			firstRetry.click();
			secondRetry.click();
			await tick();
			expect(filesApi.readContent).toHaveBeenCalledTimes(reads + 1);
			pending.resolve(imageResult);
			await screen.findByRole('img', { name: 'First' });
			expect(screen.getByRole('img', { name: 'Second' }).getAttribute('src')).toBe(
				screen.getByRole('img', { name: 'First' }).getAttribute('src'),
			);
			expect(screen.getByRole('img', { name: 'Good' })).toBe(good);
			render(Host, { cache, source: '![Retained](retained.png)', resolveImageFile });
			expect((await screen.findByRole('img', { name: 'Retained' })).getAttribute('src')).toBe(
				retainedUrl,
			);
			expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		} finally {
			cleanup();
			cache.destroy();
		}
	});

	it.each(['guide.md', 'https://example.com/guide', '/chat/1234567890123456'])(
		'places retry beside an authored link to %s and preserves navigation',
		async (destination) => {
			vi.mocked(filesApi.readContent).mockRejectedValueOnce(new Error('Not found'));
			const onLinkNavigate = vi.fn();
			render(Markdown, {
				source: `[**![Capture](capture.png)** caption](${destination})`,
				resolveImageFile,
				onLinkNavigate,
				chatReferencePolicy: 'explicit',
				resolveChatReference: () => ({ title: 'Other chat', isCurrent: false }),
			});
			const retry = await screen.findByRole('button', { name: 'Retry image Capture' });
			const link = screen.getByRole('link');
			expect(link.getAttribute('href')).toBe(destination);
			expect(retry.closest('a')).toBeNull();
			await fireEvent.click(retry);
			expect(onLinkNavigate).not.toHaveBeenCalled();
			const image = await screen.findByRole('img');
			expect(link.contains(image)).toBe(true);
			expect(screen.queryByRole('button')).toBeNull();
			if (destination === 'guide.md') {
				await fireEvent.click(image);
				expect(onLinkNavigate).toHaveBeenCalledExactlyOnceWith({
					rawHref: destination,
					kind: 'file',
				});
			}
		},
	);

	it('removes linked actions when their failed image is removed', async () => {
		vi.mocked(filesApi.readContent).mockRejectedValue(new Error('Not found'));
		const view = render(Markdown, {
			source: '[![First](first.png) ![Second](second.png)](guide.md)',
			resolveImageFile,
		});
		await screen.findByRole('button', { name: 'Retry image First' });
		await screen.findByRole('button', { name: 'Retry image Second' });
		await view.rerender({ source: '[caption](guide.md)' });
		expect(screen.queryByRole('button')).toBeNull();
		expect(screen.getByRole('link').textContent).toBe('caption');
	});

	it.each(['https://example.com/capture.png', '//example.com/capture.png'])(
		'retries native external images at %s without forwarding authentication',
		async (href) => {
			const resolver = vi.fn(resolveImageFile);
			render(Markdown, { source: `![Capture](${href})`, resolveImageFile: resolver });
			const oldImage = screen.getByRole('img');
			await fireEvent.error(oldImage);
			await fireEvent.click(screen.getByRole('button', { name: 'Retry image Capture' }));
			const image = screen.getByAltText('Capture');
			expect(image).not.toBe(oldImage);
			expect(image.getAttribute('src')).toBe(href);
			expect(image.getAttribute('loading')).toBe('eager');
			expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
			expect(screen.getByRole('status', { name: 'Loading image...' })).toBeTruthy();
			await fireEvent.error(oldImage);
			await fireEvent.load(image);
			expect(screen.queryByRole('status')).toBeNull();
			expect(screen.getByRole('img')).toBe(image);
			await fireEvent.error(image);
			expect(screen.getByRole('button', { name: 'Retry image Capture' })).toBeTruthy();
			expect(filesApi.readContent).not.toHaveBeenCalled();
			expect(resolver).not.toHaveBeenCalled();
		},
	);
});
