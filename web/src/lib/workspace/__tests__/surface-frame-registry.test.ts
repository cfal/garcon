import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	FRAME_REGISTRATION_TIMEOUT_MS,
	SurfaceAttachmentError,
	SurfaceFrameRegistry,
} from '../surface-frame-registry.svelte';

function handle(label: string) {
	const element = document.createElement('div');
	element.dataset.label = label;
	return {
		element,
		attachRetainedRenderer: vi.fn(),
		focusPrimary: vi.fn(),
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('SurfaceFrameRegistry', () => {
	it('resolves only the exact destination generation', async () => {
		const frames = new SurfaceFrameRegistry();
		const staleHandle = handle('stale');
		frames.register('terminal:1', 'window-sidebar', staleHandle);
		const expectation = frames.beginTransfer('terminal:1', 'window-sidebar');
		const wait = frames.waitFor(expectation);
		const currentHandle = handle('current');
		frames.register('terminal:1', 'window-sidebar', currentHandle);

		await expect(wait).resolves.toBe(currentHandle);
	});

	it('aborts a stale wait when a newer presentation begins', async () => {
		const frames = new SurfaceFrameRegistry();
		const first = frames.beginTransfer('file:1', 'window-main');
		const firstWait = frames.waitFor(first);
		const second = frames.beginTransfer('file:1', 'window-sidebar');

		await expect(firstWait).rejects.toMatchObject({ name: 'AbortError' });
		const destination = handle('window-sidebar');
		frames.register('file:1', 'window-sidebar', destination);
		await expect(frames.waitFor(second)).resolves.toBe(destination);
	});

	it('does not let stale cleanup remove a newer registration', async () => {
		const frames = new SurfaceFrameRegistry();
		const expectation = frames.beginTransfer('terminal:1', 'window-main');
		const staleCleanup = frames.register('terminal:1', 'window-main', handle('first'));
		const latest = handle('latest');
		frames.register('terminal:1', 'window-main', latest);
		staleCleanup();

		await expect(frames.waitFor(expectation)).resolves.toBe(latest);
	});

	it('focuses only the registered presentation frame', () => {
		const frames = new SurfaceFrameRegistry();
		const main = handle('window-main');
		frames.register('file:1', 'window-main', main);

		expect(frames.focus('file:1', 'window-sidebar')).toBe(false);
		expect(frames.focus('file:1', 'window-main')).toBe(true);
		expect(main.focusPrimary).toHaveBeenCalledOnce();
	});

	it('times out with a retryable attachment error', async () => {
		vi.useFakeTimers();
		const frames = new SurfaceFrameRegistry();
		const expectation = frames.beginTransfer('file:1', 'dialog');
		const wait = frames.waitFor(expectation);
		const assertion = expect(wait).rejects.toBeInstanceOf(SurfaceAttachmentError);
		await vi.advanceTimersByTimeAsync(FRAME_REGISTRATION_TIMEOUT_MS);

		await assertion;
	});
});
