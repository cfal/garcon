import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ImageViewer from '../ImageViewer.svelte';
import { FileSession } from '$lib/files/sessions/file-session.svelte.js';

describe('ImageViewer', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('keeps manual zoom state on the file session across presentation remounts', async () => {
		const session = new FileSession(
			{
				canonicalFileRootPath: '/workspace/project',
				normalizedRelativePath: 'image.png',
			},
			'/workspace/project\0image.png',
		);
		const first = render(ImageViewer, { session });

		await fireEvent.click(screen.getByRole('button', { name: /Zoom in/ }));
		expect(session.image.mode).toBe('manual');
		expect(session.image.scale).toBe(1.25);
		expect(screen.getByText('125%')).toBeTruthy();

		first.unmount();
		render(ImageViewer, { session });
		expect(screen.getByText('125%')).toBeTruthy();
	});

	it('keeps the initial cursor focal point stable through a rapid wheel burst', async () => {
		const session = new FileSession(
			{
				canonicalFileRootPath: '/workspace/project',
				normalizedRelativePath: 'image.png',
			},
			'/workspace/project\0image.png',
		);
		session.imageObjectUrl = 'blob:image';
		session.image = { ...session.image, mode: 'manual' };
		render(ImageViewer, { session });
		await tick();
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		let nextFrame = 1;
		const frames = new Map<number, FrameRequestCallback>();
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			const frame = nextFrame++;
			frames.set(frame, callback);
			return frame;
		});
		vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame));
		const flushFrame = () => {
			const callbacks = [...frames.values()];
			frames.clear();
			for (const callback of callbacks) callback(performance.now());
		};

		const image = screen.getByRole('img');
		const viewport = image.closest('.overflow-auto') as HTMLDivElement;
		viewport.getBoundingClientRect = () => new DOMRect(0, 0, 500, 400);
		image.getBoundingClientRect = () => new DOMRect(100, 100, 200, 100);
		viewport.scrollLeft = 0;
		viewport.scrollTop = 0;

		for (let eventIndex = 0; eventIndex < 2; eventIndex += 1) {
			const wheelEvent = new Event('wheel', { bubbles: true, cancelable: true });
			Object.defineProperties(wheelEvent, {
				ctrlKey: { value: true },
				metaKey: { value: false },
				deltaY: { value: -100 },
				clientX: { value: 150 },
				clientY: { value: 125 },
			});
			await fireEvent(viewport, wheelEvent);
		}

		expect(session.image.scale).toBeCloseTo(Math.exp(0.4));
		expect(session.image.focalX).toBeCloseTo(0.25);
		expect(session.image.focalY).toBeCloseTo(0.25);

		image.getBoundingClientRect = () => new DOMRect(80, 80, 400, 200);
		flushFrame();
		expect(viewport.scrollLeft).toBe(30);
		expect(viewport.scrollTop).toBe(5);

		viewport.dispatchEvent(new Event('scroll'));
		expect(session.image.focalX).toBeCloseTo(0.25);
		expect(session.image.focalY).toBeCloseTo(0.25);
		expect(session.image.scrollLeft).toBe(30);
		expect(session.image.scrollTop).toBe(5);
	});
});
