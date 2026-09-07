import { afterEach, describe, expect, it, vi } from 'vitest';
import { surfaceFrame } from '../surface-frame-action.js';
import { SurfaceFrameBridge } from '../surface-frame-context.js';
import { SurfaceFrameRegistry } from '../surface-frame-registry.svelte.js';

describe('surfaceFrame', () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it('focuses an explicit primary target before toolbar controls', () => {
		const registry = new SurfaceFrameRegistry();
		const surface = document.createElement('div');
		const toolbarButton = document.createElement('button');
		const primaryTarget = document.createElement('textarea');
		primaryTarget.dataset.surfacePrimary = '';
		surface.append(toolbarButton, primaryTarget);
		document.body.append(surface);
		const action = surfaceFrame(surface, {
			registry,
			surfaceId: 'test-surface',
			host: 'window-main',
			version: 0,
		});

		expect(registry.focus('test-surface', 'window-main')).toBe(true);
		expect(document.activeElement).toBe(primaryTarget);

		action.destroy();
	});

	it('transfers fallback focus to a renderer that finishes attaching later', async () => {
		const registry = new SurfaceFrameRegistry();
		const renderer = new SurfaceFrameBridge();
		const surface = document.createElement('div');
		const fallback = document.createElement('textarea');
		fallback.dataset.surfacePrimary = '';
		surface.append(fallback);
		document.body.append(surface);
		const action = surfaceFrame(surface, {
			registry,
			surfaceId: 'test-surface',
			host: 'window-main',
			version: 0,
			renderer,
			waitForRenderer: false,
		});
		await renderer.activate(false);

		expect(registry.focus('test-surface', 'window-main')).toBe(true);
		expect(document.activeElement).toBe(fallback);
		const focusPrimary = vi.fn();
		renderer.provideRenderer({ attach: vi.fn(), detach: vi.fn(), focusPrimary });

		await vi.waitFor(() => expect(focusPrimary).toHaveBeenCalledOnce());
		action.destroy();
	});

	it('does not reclaim focus after the user leaves a loading surface', async () => {
		const registry = new SurfaceFrameRegistry();
		const renderer = new SurfaceFrameBridge();
		const surface = document.createElement('div');
		const fallback = document.createElement('textarea');
		fallback.dataset.surfacePrimary = '';
		const nextTarget = document.createElement('button');
		surface.append(fallback);
		document.body.append(surface, nextTarget);
		const action = surfaceFrame(surface, {
			registry,
			surfaceId: 'test-surface',
			host: 'window-main',
			version: 0,
			renderer,
			waitForRenderer: false,
		});
		await renderer.activate(false);
		registry.focus('test-surface', 'window-main');
		nextTarget.focus();
		const attach = vi.fn();
		const focusPrimary = vi.fn();

		renderer.provideRenderer({ attach, detach: vi.fn(), focusPrimary });
		await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
		await Promise.resolve();
		await Promise.resolve();

		expect(document.activeElement).toBe(nextTarget);
		expect(focusPrimary).not.toHaveBeenCalled();
		action.destroy();
	});
});
