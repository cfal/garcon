import { describe, expect, it } from 'vitest';
import { createPerListWriteQueue, type PerListWrite } from '../reorder-write-queue';
import type { PersistedChatOrderGroup } from '$shared/chat-order-contracts';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe('createPerListWriteQueue', () => {
	it('serializes writes in order for the same list', async () => {
		interface WindowWrite extends PerListWrite<PersistedChatOrderGroup> {
			oldOrder: string[];
			newOrder: string[];
		}

		const started: WindowWrite[] = [];
		const inFlight: Array<{ resolve: () => void }> = [];

		const queue = createPerListWriteQueue<PersistedChatOrderGroup, WindowWrite>(
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
		queue.enqueue({ list: 'pinned', oldOrder: ['b', 'c', 'a'], newOrder: ['c', 'b', 'a'] });

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
		expect(started[2].list).toBe('pinned');
		expect(started[2].newOrder).toEqual(['c', 'b', 'a']);
	});

	it('serializes relative placements by list', async () => {
		interface QuickMoveWrite extends PerListWrite<PersistedChatOrderGroup> {
			chatId: string;
			placement: { kind: 'relative'; referenceChatId: string; position: 'before' | 'after' };
		}

		const started: QuickMoveWrite[] = [];
		const completed: string[] = [];
		const inFlight: Array<{ resolve: () => void }> = [];
		const queue = createPerListWriteQueue<PersistedChatOrderGroup, QuickMoveWrite>(
			async (task) => {
				started.push(task);
				const gate = deferred<void>();
				inFlight.push({ resolve: () => gate.resolve() });
				await gate.promise;
			},
			() => {},
		);

		queue.enqueue({
			list: 'normal',
			chatId: 'a',
			placement: { kind: 'relative', referenceChatId: 'b', position: 'after' },
			onSuccess: () => completed.push('above'),
		});
		queue.enqueue({
			list: 'normal',
			chatId: 'a',
			placement: { kind: 'relative', referenceChatId: 'b', position: 'before' },
			onSuccess: () => completed.push('below'),
		});

		await Promise.resolve();
		expect(started).toHaveLength(1);
		expect(started[0].placement).toEqual({
			kind: 'relative',
			referenceChatId: 'b',
			position: 'after',
		});

		inFlight[0].resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(started).toHaveLength(2);
		expect(started[1].placement).toEqual({
			kind: 'relative',
			referenceChatId: 'b',
			position: 'before',
		});
		expect(completed).toEqual(['above']);

		inFlight[1].resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(completed).toEqual(['above', 'below']);
	});
});
