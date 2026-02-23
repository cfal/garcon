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
					{ id: 'ok', content: 'hello', status: 'queued', createdAt: '2026-02-27T00:00:00.000Z' },
					{ id: 1, content: 'bad', status: 'queued', createdAt: '2026-02-27T00:00:00.000Z' },
				],
			},
		});

		expect(parsed instanceof QueueStateUpdatedMessage).toBe(true);
		if (!(parsed instanceof QueueStateUpdatedMessage)) return;
		expect(parsed.queue.entries).toHaveLength(1);
		expect(parsed.queue.entries[0].id).toBe('ok');
	});
});
