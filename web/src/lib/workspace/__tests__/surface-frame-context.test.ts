import { describe, expect, it, vi } from 'vitest';
import { SurfaceFrameBridge } from '../surface-frame-context.js';

function provider() {
	return {
		attach: vi.fn(),
		detach: vi.fn(),
		focusPrimary: vi.fn(),
	};
}

describe('SurfaceFrameBridge', () => {
	it('attaches a renderer only after frame activation', async () => {
		const bridge = new SurfaceFrameBridge();
		const renderer = provider();
		bridge.provideRenderer(renderer);

		expect(renderer.attach).not.toHaveBeenCalled();
		await bridge.activate();
		expect(renderer.attach).toHaveBeenCalledOnce();
	});

	it('attaches a late renderer into an already active frame', async () => {
		const bridge = new SurfaceFrameBridge();
		await bridge.activate();
		const renderer = provider();
		bridge.provideRenderer(renderer);
		await Promise.resolve();

		expect(renderer.attach).toHaveBeenCalledOnce();
	});

	it('detaches before reactivation and ignores stale provider cleanup', async () => {
		const bridge = new SurfaceFrameBridge();
		const first = provider();
		const unregisterFirst = bridge.provideRenderer(first);
		await bridge.activate();
		bridge.deactivate();
		const second = provider();
		bridge.provideRenderer(second);
		await bridge.activate();
		unregisterFirst();

		expect(first.detach).toHaveBeenCalledOnce();
		expect(second.attach).toHaveBeenCalledOnce();
		expect(second.detach).not.toHaveBeenCalled();
	});

	it('delegates focus only while a provider is registered', () => {
		const bridge = new SurfaceFrameBridge();
		const renderer = provider();
		expect(bridge.focusPrimary()).toBe(false);
		const unregister = bridge.provideRenderer(renderer);

		expect(bridge.focusPrimary()).toBe(true);
		expect(renderer.focusPrimary).toHaveBeenCalledOnce();
		unregister();
		expect(bridge.focusPrimary()).toBe(false);
	});
});
