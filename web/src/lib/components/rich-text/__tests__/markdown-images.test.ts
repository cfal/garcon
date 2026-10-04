import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as filesApi from '$lib/api/files.js';
import {
	resolveImageFileTarget,
	type ResolveMarkdownImageFile,
} from '$lib/chat/file-links/file-link-resolver.js';
import Markdown from '../Markdown.svelte';

const imageResult = {
	blob: new Blob(['synthetic'], { type: 'image/png' }),
	revision: 'v1:synthetic' as const,
};
const resolveImageFile: ResolveMarkdownImageFile = (href) =>
	resolveImageFileTarget(href, {
		executorId: 'worker',
		executorContextKey: 'synthetic-worker-context',
		fileRootPath: '/workspace',
		sourceDirectoryPath: '/workspace/project',
	});

describe('Markdown images', () => {
	beforeEach(() => {
		vi.stubGlobal('IntersectionObserver', undefined);
		let nextUrl = 0;
		vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${++nextUrl}`);
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		vi.spyOn(filesApi, 'readContent').mockResolvedValue(imageResult);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('loads a local file through the file API and releases it on unmount', async () => {
		const view = render(Markdown, {
			source: '![Capture](capture.png "Desktop")',
			resolveImageFile,
		});
		await waitFor(() =>
			expect(screen.getByRole('img', { name: 'Capture' }).getAttribute('src')).toBe(
				'blob:preview-1',
			),
		);
		expect(filesApi.readContent).toHaveBeenCalledWith(
			{
				executorId: 'worker',
				projectPath: '/workspace',
				filePath: 'project/capture.png',
			},
			{ signal: expect.any(AbortSignal), cache: 'no-store' },
		);
		expect(screen.getByRole('img').getAttribute('title')).toBe('Desktop');
		const signal = vi.mocked(filesApi.readContent).mock.calls[0][1]?.signal;
		view.unmount();
		expect(signal?.aborted).toBe(true);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
	});

	it.each([
		'https://example.com/capture.png',
		'http://example.com/capture.png',
		'//example.com/capture.png',
	])('leaves %s native and never forwards API authentication', async (href) => {
		const resolver = vi.fn(resolveImageFile);
		render(Markdown, { source: `![Capture](${href})`, resolveImageFile: resolver });
		await tick();
		const image = screen.getByRole('img');
		expect(image.getAttribute('src')).toBe(href);
		expect(image.getAttribute('loading')).toBe('lazy');
		expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
		expect(resolver).not.toHaveBeenCalled();
		expect(filesApi.readContent).not.toHaveBeenCalled();
	});

	it.each([
		'capture.png',
		'/scratch/capture.png',
		'C:/workspace/capture.png',
		'C:\\workspace\\capture.png',
		'data:image/png;base64,eA==',
		'blob:untrusted',
		'javascript:alert(1)',
	])('never requests %s without a trusted file resolver', async (href) => {
		const { container } = render(Markdown, { source: `![Capture](${href})` });
		await tick();
		expect(container.querySelector('img')).toBeNull();
		expect(filesApi.readContent).not.toHaveBeenCalled();
		expect(screen.getByText('Unable to load image')).toBeTruthy();
	});

	it.each(['C:/workspace/capture.png', 'C:\\workspace\\capture.png'])(
		'resolves Windows image path %s without weakening link sanitization',
		async (href) => {
			const { container } = render(Markdown, {
				source: `![Capture](${href})\n\n[Windows link](${href})`,
				resolveImageFile: (path) =>
					resolveImageFileTarget(path, {
						executorId: 'windows-worker',
						executorContextKey: 'synthetic-windows-context',
						fileRootPath: 'C:/workspace',
						sourceDirectoryPath: 'C:/workspace/project',
					}),
			});
			await waitFor(() =>
				expect(screen.getByRole('img').getAttribute('src')).toBe('blob:preview-1'),
			);
			expect(filesApi.readContent).toHaveBeenCalledWith(
				{ executorId: 'windows-worker', projectPath: 'C:/workspace', filePath: 'capture.png' },
				{ signal: expect.any(AbortSignal), cache: 'no-store' },
			);
			expect(container.querySelector('a')?.getAttribute('href')).toBeNull();
		},
	);

	it('starts one authenticated request only when the preview becomes visible', async () => {
		let enter: () => void = () => {};
		const disconnect = vi.fn();
		vi.stubGlobal(
			'IntersectionObserver',
			class implements IntersectionObserver {
				root = null;
				rootMargin = '50px';
				scrollMargin = '0px';
				thresholds = [0];
				disconnect = disconnect;
				unobserve = vi.fn();
				takeRecords = () => [];
				constructor(private callback: IntersectionObserverCallback) {}
				observe(target: Element): void {
					enter = () =>
						this.callback(
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
							this,
						);
				}
			},
		);
		const view = render(Markdown, { source: '![Capture](capture.png)', resolveImageFile });
		await tick();
		expect(filesApi.readContent).not.toHaveBeenCalled();
		enter();
		enter();
		await waitFor(() => expect(filesApi.readContent).toHaveBeenCalledOnce());
		expect(disconnect).toHaveBeenCalled();
		view.unmount();
		expect(disconnect).toHaveBeenCalledTimes(2);
	});

	it.each(['executorId', 'executorContextKey'] as const)(
		'aborts a stale %s request and ignores its late completion',
		async (field) => {
			let finishFirst!: (result: typeof imageResult) => void;
			vi.mocked(filesApi.readContent).mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishFirst = resolve;
					}),
			);
			const view = render(Markdown, { source: '![Capture](capture.png)', resolveImageFile });
			await waitFor(() => expect(filesApi.readContent).toHaveBeenCalledOnce());
			const signal = vi.mocked(filesApi.readContent).mock.calls[0][1]?.signal;
			const nextResolver: ResolveMarkdownImageFile = (href) => ({
				...resolveImageFile(href)!,
				[field]: 'replacement-context',
			});
			await view.rerender({ source: '![Capture](capture.png)', resolveImageFile: nextResolver });
			await waitFor(() =>
				expect(screen.getByRole('img').getAttribute('src')).toBe('blob:preview-1'),
			);
			expect(signal?.aborted).toBe(true);
			finishFirst(imageResult);
			await tick();
			expect(URL.createObjectURL).toHaveBeenCalledOnce();
			expect(screen.getByRole('img').getAttribute('src')).toBe('blob:preview-1');
		},
	);

	it('does not create an object URL when a pending request completes after unmount', async () => {
		let finish!: (result: typeof imageResult) => void;
		vi.mocked(filesApi.readContent).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const view = render(Markdown, { source: '![Capture](capture.png)', resolveImageFile });
		await waitFor(() => expect(filesApi.readContent).toHaveBeenCalledOnce());
		view.unmount();
		finish(imageResult);
		await tick();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it('retains equivalent targets and revokes replaced sources', async () => {
		const view = render(Markdown, { source: '![Capture](first.png)', resolveImageFile });
		await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:preview-1'));
		await view.rerender({
			source: '![Capture](first.png)',
			resolveImageFile: (href) => resolveImageFile(href),
		});
		expect(filesApi.readContent).toHaveBeenCalledOnce();
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		await view.rerender({ source: '![Capture](second.png)', resolveImageFile });
		await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:preview-2'));
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
		view.unmount();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-2');
	});

	it('releases undecodable images and recovers on a new source', async () => {
		const view = render(Markdown, { source: '![Capture](first.png)', resolveImageFile });
		await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:preview-1'));
		const oldImage = screen.getByRole('img');
		await fireEvent.error(oldImage);
		expect(screen.getByText('Unable to load image')).toBeTruthy();
		expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview-1');
		await view.rerender({ source: '![Capture](second.png)', resolveImageFile });
		await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:preview-2'));
		await fireEvent.error(oldImage);
		expect(screen.getByRole('img').getAttribute('src')).toBe('blob:preview-2');
	});

	it.each(['request', 'content-type'])('fails closed after a %s failure', async (failure) => {
		if (failure === 'request')
			vi.mocked(filesApi.readContent).mockRejectedValueOnce(new Error('Not found'));
		else
			vi.mocked(filesApi.readContent).mockResolvedValueOnce({
				...imageResult,
				blob: new Blob(['private text'], { type: 'text/plain' }),
			});
		const { container } = render(Markdown, { source: '![Capture](capture.png)', resolveImageFile });
		await waitFor(() => expect(screen.getByText('Unable to load image')).toBeTruthy());
		expect(container.querySelector('img')).toBeNull();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});
});
