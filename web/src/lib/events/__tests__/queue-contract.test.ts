import { describe, it, expect } from 'vitest';
import { parseServerWsMessage, QueueStateUpdatedMessage } from '$shared/ws-events';

describe('queue-state WS contract', () => {
	it('normalizes a pause away when queue has no editable entries', () => {
		const parsed = parseServerWsMessage({
			type: 'queue-state-updated',
			chatId: '123',
			queue: {
				entries: [],
				pause: { id: 'pause-1', kind: 'manual', pausedAt: '2026-07-16T00:00:00.000Z' },
			},
		});

		expect(parsed instanceof QueueStateUpdatedMessage).toBe(true);
		if (!(parsed instanceof QueueStateUpdatedMessage)) return;
		expect(parsed.queue.entries).toEqual([]);
		expect(parsed.queue.pause).toBeNull();
	});

	it('preserves restart uncertainty when queue has no editable entries', () => {
		const pause = {
			id: 'pause-recovery',
			kind: 'recovered-unconfirmed-input',
			pausedAt: '2026-07-18T00:00:00.000Z',
		};
		const parsed = parseServerWsMessage({
			type: 'queue-state-updated',
			chatId: '123',
			queue: { entries: [], pause },
		});

		expect(parsed).toBeInstanceOf(QueueStateUpdatedMessage);
		if (!(parsed instanceof QueueStateUpdatedMessage)) return;
		expect(parsed.queue.pause).toEqual(pause);
	});

	it('drops invalid queue entries at parse boundary', () => {
		const parsed = parseServerWsMessage({
			type: 'queue-state-updated',
			chatId: '123',
			queue: {
				pause: { id: 'pause-1', kind: 'manual', pausedAt: '2026-07-16T00:00:00.000Z' },
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

	it.each([
		{ id: 'manual', kind: 'manual', pausedAt: '2026-07-16T00:00:00.000Z' },
		{
			id: 'failed',
			kind: 'queued-turn-failed',
			entryId: 'ok',
			pausedAt: '2026-07-16T00:00:00.000Z',
		},
		{
			id: 'recovered',
			kind: 'recovered-inflight',
			entryId: 'ok',
			pausedAt: '2026-07-16T00:00:00.000Z',
		},
		{
			id: 'recovered-input',
			kind: 'recovered-unconfirmed-input',
			pausedAt: '2026-07-16T00:00:00.000Z',
		},
		{
			id: 'uncertain',
			kind: 'completion-uncertain',
			entryId: 'ok',
			pausedAt: '2026-07-16T00:00:00.000Z',
		},
		{ id: 'unknown', kind: 'unknown', entryId: 'ok', pausedAt: null },
	])('round-trips the $kind pause variant', (pause) => {
		const parsed = parseServerWsMessage({
			type: 'queue-state-updated',
			chatId: '123',
			queue: {
				entries: [
					{ id: 'ok', content: 'hello', revision: 1, createdAt: '2026-07-16T00:00:00.000Z' },
				],
				pause,
			},
		});

		expect(parsed).toBeInstanceOf(QueueStateUpdatedMessage);
		if (!(parsed instanceof QueueStateUpdatedMessage)) return;
		expect(parsed.queue.pause).toEqual(pause);
	});

	it.each([
		undefined,
		true,
		{ id: '', kind: 'manual', pausedAt: '2026-07-16T00:00:00.000Z' },
		{ id: 'pause-1', kind: 'manual', pausedAt: 'invalid' },
		{ id: 'pause-1', kind: 'queued-turn-failed', pausedAt: '2026-07-16T00:00:00.000Z' },
	])('rejects malformed pause state %#', (pause) => {
		expect(parseServerWsMessage({
			type: 'queue-state-updated',
			chatId: '123',
			queue: { entries: [], pause },
		})).toBeNull();
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
				pause: null,
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
				pause: null,
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
