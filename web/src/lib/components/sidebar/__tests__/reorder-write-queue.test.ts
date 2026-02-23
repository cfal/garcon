import { describe, expect, it } from 'vitest';
import { createReorderWriteQueue, type ReorderWrite } from '../reorder-write-queue';
import type { ChatOrderList } from '$lib/api/chats';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe('createReorderWriteQueue', () => {
	it('serializes writes and coalesces pending updates for the same list', async () => {
		const started: ReorderWrite<ChatOrderList>[] = [];
		const inFlight: Array<{ resolve: () => void }> = [];

		const queue = createReorderWriteQueue<ChatOrderList>(
			async (task) => {
				started.push(task);
				const gate = deferred<void>();
				inFlight.push({ resolve: () => gate.resolve() });
				await gate.promise;
			},
			() => {},
		);

		queue.enqueue({ list: 'pinned', oldOrder: ['a', 'b'], newOrder: ['b', 'a'] });
		queue.enqueue({ list: 'pinned', oldOrder: ['b', 'a'], newOrder: ['b', 'c', 'a'] });
		queue.enqueue({ list: 'normal', oldOrder: ['n1', 'n2'], newOrder: ['n2', 'n1'] });

		await Promise.resolve();
		expect(started).toHaveLength(1);
		expect(started[0].list).toBe('pinned');
		expect(started[0].newOrder).toEqual(['b', 'a']);

		inFlight[0].resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(started).toHaveLength(2);
		expect(started[1].list).toBe('pinned');
		expect(started[1].newOrder).toEqual(['b', 'c', 'a']);

		inFlight[1].resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(started).toHaveLength(3);
		expect(started[2].list).toBe('normal');
		expect(started[2].newOrder).toEqual(['n2', 'n1']);
	});
});
