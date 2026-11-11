import { describe, expect, it, vi } from 'vitest';
import { FileImageLoadQueue } from '../file-image-load-queue';

describe('FileImageLoadQueue', () => {
	it('bounds waiting work and releases cancelled requests without starting them', async () => {
		const queue = new FileImageLoadQueue();
		const active = Promise.withResolvers<void>();
		const started = vi.fn(() => active.promise);
		const controllers = Array.from({ length: 68 }, () => new AbortController());
		const results = controllers.map((controller) =>
			queue.run(started, controller.signal).catch((error: unknown) => error),
		);
		expect(started).toHaveBeenCalledTimes(4);
		await expect(queue.run(started, new AbortController().signal)).rejects.toThrow('queue is full');
		controllers[4].abort();
		const replacement = queue.run(started, new AbortController().signal);
		active.resolve();
		await Promise.all([...results, replacement]);
		expect(started).toHaveBeenCalledTimes(68);
	});

	it('keeps an active slot reserved until cancelled IO actually settles', async () => {
		const queue = new FileImageLoadQueue();
		const active = Promise.withResolvers<void>();
		const controller = new AbortController();
		const running = Array.from({ length: 4 }, () =>
			queue.run(() => active.promise, controller.signal),
		);
		const next = vi.fn(async () => {});
		const waiting = queue.run(next, new AbortController().signal);
		controller.abort();
		await Promise.resolve();
		expect(next).not.toHaveBeenCalled();
		active.resolve();
		await Promise.all([...running, waiting]);
		expect(next).toHaveBeenCalledOnce();
	});

	it('continues after failed loads and rejects already cancelled demand', async () => {
		const queue = new FileImageLoadQueue();
		const cancelled = new AbortController();
		cancelled.abort();
		const start = vi.fn(async () => {});
		await expect(queue.run(start, cancelled.signal)).rejects.toThrow();
		expect(start).not.toHaveBeenCalled();
		await expect(
			queue.run(async () => {
				throw new Error('read failed');
			}, new AbortController().signal),
		).rejects.toThrow('read failed');
		await queue.run(start, new AbortController().signal);
		expect(start).toHaveBeenCalledOnce();
	});
});
