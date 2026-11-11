import { describe, expect, it, vi } from 'vitest';
import { SurfaceFrameRegistry } from '../surface-frame-registry';
import { WorkspacePresentationFrames } from '../workspace-presentation-frames.svelte';

describe('WorkspacePresentationFrames', () => {
	it('releases versions and registrations after repeated permanent removals', async () => {
		const frames = new SurfaceFrameRegistry();
		const presentation = new WorkspacePresentationFrames({
			frames,
			files: { get: () => null },
			terminals: { prepareRendererTransfer: () => {} },
		});
		for (let index = 0; index < 100; index += 1) {
			const surfaceId = `file:${index}`;
			const retry = presentation.retry(surfaceId, 'window-main');
			frames.register(surfaceId, 'window-main', {
				element: document.createElement('div'),
				attachRetainedRenderer: () => {},
				focusPrimary: () => {},
			});
			await expect(retry).resolves.toBe(true);
			expect(presentation.version(surfaceId)).toBe(1);
			presentation.release(surfaceId);
			expect(frames.focus(surfaceId, 'window-main')).toBe(false);
		}
		expect(presentation.versions).toEqual({});
		expect(presentation.errors).toEqual({});
		frames.destroy();
	});

	it('does not recreate errors after a released renderer fails to attach', async () => {
		const frames = new SurfaceFrameRegistry();
		const presentation = new WorkspacePresentationFrames({
			frames,
			files: { get: () => null },
			terminals: { prepareRendererTransfer: () => {} },
		});
		const attachment = Promise.withResolvers<void>();
		const attach = vi.fn(() => attachment.promise);
		const retry = presentation.retry('file:1', 'window-main');
		frames.register('file:1', 'window-main', {
			element: document.createElement('div'),
			attachRetainedRenderer: attach,
			focusPrimary: () => {},
		});
		await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
		presentation.release('file:1');
		attachment.reject(new Error('Late attachment failure'));
		await expect(retry).resolves.toBe(false);
		expect(presentation.errors).toEqual({});
		expect(presentation.versions).toEqual({});
		frames.destroy();
	});
});
