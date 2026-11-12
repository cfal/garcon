import { describe, expect, it, vi } from 'vitest';
import { FileImageLoadQueue } from '../file-image-load-queue';

describe('FileImageLoadQueue', () => {
	it('bounds active work without rejecting live requests and removes cancelled requests', async () => {
		const queue = new FileImageLoadQueue();
		const active = Promise.withResolvers<void>();
		const started = vi.fn(() => active.promise);
		const controllers = Array.from({ length: 100 }, () => new AbortController());
		const results = Promise.allSettled(
			controllers.map((controller) => queue.run(started, controller.signal)),
		);
		expect(started).toHaveBeenCalledTimes(4);
		controllers[4].abort();
		const replacement = queue.run(started, new AbortController().signal);
		active.resolve();
		const outcomes = await results;
		await expect(replacement).resolves.toBeUndefined();
		expect(outcomes[4]).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
		expect(outcomes.filter((_, index) => index !== 4)).toEqual(
			Array.from({ length: 99 }, () => ({ status: 'fulfilled', value: undefined })),
		);
		expect(started).toHaveBeenCalledTimes(100);
	});

	it('admits one waiter per freed slot and removes queued abort listeners', async () => {
		const queue = new FileImageLoadQueue();
		const gates = Array.from({ length: 7 }, () => Promise.withResolvers<void>());
		const controllers = gates.map(() => new AbortController());
		const removals = controllers.map(({ signal }) => vi.spyOn(signal, 'removeEventListener'));
		const started: number[] = [];
		const results = Promise.allSettled(
			gates.map((gate, index) =>
				queue.run(() => {
					started.push(index);
					return gate.promise;
				}, controllers[index].signal),
			),
		);
		try {
			expect(started).toEqual([0, 1, 2, 3]);
			expect(removals[4]).not.toHaveBeenCalled();
			controllers[4].abort();
			expect(removals[4]).toHaveBeenCalledWith('abort', expect.any(Function));
			gates[2].resolve();
			await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 5]));
			expect(removals[5]).toHaveBeenCalledWith('abort', expect.any(Function));
			expect(removals[6]).not.toHaveBeenCalled();
			gates[0].reject(new Error('Read failed'));
			await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 5, 6]));
		} finally {
			for (const gate of gates) gate.resolve();
			await results;
			vi.restoreAllMocks();
		}
		expect(await results).toEqual(
			gates.map((_, index) => {
				if (index === 0) return { status: 'rejected', reason: new Error('Read failed') };
				if (index === 4)
					return {
						status: 'rejected',
						reason: expect.objectContaining({ name: 'AbortError' }),
					};
				return { status: 'fulfilled', value: undefined };
			}),
		);
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
