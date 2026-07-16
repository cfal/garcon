import { describe, it, expect } from 'vitest';
import { parseServerWsMessage, QueueStateUpdatedMessage } from '$shared/ws-events';

describe('queue-state WS contract', () => {
	it('normalizes paused=false when queue has no entries', () => {
		const parsed = parseServerWsMessage({
			type: 'queue-state-updated',
			chatId: '123',
			queue: { entries: [], paused: true },
		});

		expect(parsed instanceof QueueStateUpdatedMessage).toBe(true);
		if (!(parsed instanceof QueueStateUpdatedMessage)) return;
		expect(parsed.queue.entries).toEqual([]);
		expect(parsed.queue.paused).toBe(false);
	});

	it('drops invalid queue entries at parse boundary', () => {
		const parsed = parseServerWsMessage({
			type: 'queue-state-updated',
			chatId: '123',
			queue: {
				paused: true,
				entries: [
					{ id: 'ok', content: 'hello', revision: 2, createdAt: '2026-02-27T00:00:00.000Z' },
					{ id: 1, content: 'bad', revision: 1, createdAt: '2026-02-27T00:00:00.000Z' },
				],
			},
		});

		expect(parsed instanceof QueueStateUpdatedMessage).toBe(true);
		if (!(parsed instanceof QueueStateUpdatedMessage)) return;
		expect(parsed.queue.entries).toHaveLength(1);
		expect(parsed.queue.entries[0].id).toBe('ok');
		expect(parsed.queue.entries[0].revision).toBe(2);
	});

	it('preserves dispatch identity and drops malformed sent markers', () => {
		const parsed = parseServerWsMessage({
			type: 'queue-state-updated',
			chatId: '123',
			queue: {
				entries: [],
				dispatchingEntryId: 'entry-1',
				recentlyDispatched: [
					{ entryId: 'entry-1', dispatchedAt: '2026-07-16T00:00:00.000Z' },
					{ entryId: 2, dispatchedAt: 'invalid' },
				],
				paused: false,
			},
		});

		expect(parsed instanceof QueueStateUpdatedMessage).toBe(true);
		if (!(parsed instanceof QueueStateUpdatedMessage)) return;
		expect(parsed.queue.dispatchingEntryId).toBe('entry-1');
		expect(parsed.queue.recentlyDispatched).toEqual([
			{ entryId: 'entry-1', dispatchedAt: '2026-07-16T00:00:00.000Z' },
		]);
	});

	it('preserves queue version and updatedAt fields', () => {
		const parsed = parseServerWsMessage({
			type: 'queue-state-updated',
			chatId: '123',
			queue: {
				paused: false,
				entries: [],
				version: 7,
				updatedAt: '2026-05-14T00:00:00.000Z',
			},
		});

		expect(parsed instanceof QueueStateUpdatedMessage).toBe(true);
		if (!(parsed instanceof QueueStateUpdatedMessage)) return;
		expect(parsed.queue.version).toBe(7);
		expect(parsed.queue.updatedAt).toBe('2026-05-14T00:00:00.000Z');
	});
});
