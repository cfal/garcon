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
		frames.register('terminal:1', 'pane-sidebar', staleHandle);
		const expectation = frames.beginTransfer('terminal:1', 'pane-sidebar');
		const wait = frames.waitFor(expectation);
		const currentHandle = handle('current');
		frames.register('terminal:1', 'pane-sidebar', currentHandle);

		await expect(wait).resolves.toBe(currentHandle);
	});

	it('aborts a stale wait when a newer presentation begins', async () => {
		const frames = new SurfaceFrameRegistry();
		const first = frames.beginTransfer('file:1', 'pane-main');
		const firstWait = frames.waitFor(first);
		const second = frames.beginTransfer('file:1', 'pane-sidebar');

		await expect(firstWait).rejects.toMatchObject({ name: 'AbortError' });
		const destination = handle('pane-sidebar');
		frames.register('file:1', 'pane-sidebar', destination);
		await expect(frames.waitFor(second)).resolves.toBe(destination);
	});

	it('does not let stale cleanup remove a newer registration', async () => {
		const frames = new SurfaceFrameRegistry();
		const expectation = frames.beginTransfer('terminal:1', 'pane-main');
		const staleCleanup = frames.register('terminal:1', 'pane-main', handle('first'));
		const latest = handle('latest');
		frames.register('terminal:1', 'pane-main', latest);
		staleCleanup();

		await expect(frames.waitFor(expectation)).resolves.toBe(latest);
	});

	it('focuses only the registered presentation frame', () => {
		const frames = new SurfaceFrameRegistry();
		const main = handle('pane-main');
		frames.register('file:1', 'pane-main', main);

		expect(frames.focus('file:1', 'pane-sidebar')).toBe(false);
		expect(frames.focus('file:1', 'pane-main')).toBe(true);
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
