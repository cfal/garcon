import { afterEach, describe, expect, it, vi } from 'vitest';
import { SurfaceFrameBridge, SurfaceRendererActivationError } from '../surface-frame-context.js';
import { FRAME_REGISTRATION_TIMEOUT_MS } from '../surface-frame-registry.svelte.js';

function provider() {
	return {
		attach: vi.fn(),
		detach: vi.fn(),
		focusPrimary: vi.fn(),
	};
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe('SurfaceFrameBridge', () => {
	afterEach(() => vi.useRealTimers());

	it('attaches a renderer only after frame activation', async () => {
		const bridge = new SurfaceFrameBridge();
		const renderer = provider();
		bridge.provideRenderer(renderer);

		expect(renderer.attach).not.toHaveBeenCalled();
		await bridge.activate();
		expect(renderer.attach).toHaveBeenCalledOnce();
	});

	it('waits for a late renderer before reporting activation success', async () => {
		const bridge = new SurfaceFrameBridge();
		const activation = bridge.activate();
		let settled = false;
		void activation.then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);

		const renderer = provider();
		bridge.provideRenderer(renderer);
		await activation;

		expect(renderer.attach).toHaveBeenCalledOnce();
		expect(settled).toBe(true);
	});

	it('times out when a required renderer provider never appears', async () => {
		vi.useFakeTimers();
		const bridge = new SurfaceFrameBridge();
		const activation = bridge.activate();
		const rejection = expect(activation).rejects.toBeInstanceOf(SurfaceRendererActivationError);

		await vi.advanceTimersByTimeAsync(FRAME_REGISTRATION_TIMEOUT_MS);

		await rejection;
	});

	it('settles an optional-renderer frame and still attaches a later provider', async () => {
		const bridge = new SurfaceFrameBridge();
		await expect(bridge.activate(false)).resolves.toBeUndefined();
		const renderer = provider();

		bridge.provideRenderer(renderer);

		await vi.waitFor(() => expect(renderer.attach).toHaveBeenCalledOnce());
	});

	it('rejects activation when a late renderer fails to attach', async () => {
		const bridge = new SurfaceFrameBridge();
		const activation = bridge.activate();
		const renderer = provider();
		renderer.attach.mockRejectedValueOnce(new Error('renderer failed'));

		bridge.provideRenderer(renderer);

		await expect(activation).rejects.toThrow('renderer failed');
		expect(renderer.attach).toHaveBeenCalledOnce();
	});

	it('cancels a delayed renderer activation when the frame deactivates', async () => {
		const bridge = new SurfaceFrameBridge();
		const attachment = deferred<void>();
		const renderer = provider();
		renderer.attach.mockReturnValueOnce(attachment.promise);
		bridge.provideRenderer(renderer);
		const activation = bridge.activate();
		await vi.waitFor(() => expect(renderer.attach).toHaveBeenCalledOnce());

		bridge.deactivate();

		await expect(activation).rejects.toMatchObject({ name: 'AbortError' });
		expect(renderer.detach).toHaveBeenCalledOnce();
		attachment.resolve();
		await Promise.resolve();
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
