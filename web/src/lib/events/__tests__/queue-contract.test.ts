import { describe, expect, it } from 'vitest';
import { ChatExecutionControlUpdatedMessage, parseServerWsMessage } from '$shared/ws-events';

const installedAt = '2026-07-18T00:00:00.000Z';
const continuationId = '8c8c35c6-2189-49cf-a94b-b63e29b972ba';

function control(overrides: Record<string, unknown> = {}) {
	return {
		queue: {
			entries: [],
			dispatchingEntryId: null,
			recentlyDispatched: [],
			pause: null,
		},
		recoveredInputContinuation: null,
		version: 7,
		updatedAt: installedAt,
		...overrides,
	};
}

describe('chat execution-control WS contract', () => {
	it('parses one composite versioned snapshot', () => {
		const parsed = parseServerWsMessage({
			type: 'chat-execution-control-updated',
			chatId: '123',
			control: control({
				recoveredInputContinuation: { id: continuationId, installedAt },
			}),
		});

		expect(parsed).toBeInstanceOf(ChatExecutionControlUpdatedMessage);
		if (!(parsed instanceof ChatExecutionControlUpdatedMessage)) return;
		expect(parsed.control.version).toBe(7);
		expect(parsed.control.updatedAt).toBe(installedAt);
		expect(parsed.control.queue.entries).toEqual([]);
		expect(parsed.control.recoveredInputContinuation).toEqual({ id: continuationId, installedAt });
	});

	it.each([
		{ id: 'manual', kind: 'manual', pausedAt: installedAt },
		{ id: 'failed', kind: 'queued-turn-failed', entryId: 'ok', pausedAt: installedAt },
		{ id: 'recovered', kind: 'recovered-inflight', entryId: 'ok', pausedAt: installedAt },
		{ id: 'uncertain', kind: 'completion-uncertain', entryId: 'ok', pausedAt: installedAt },
		{ id: 'unknown', kind: 'unknown', entryId: 'ok', pausedAt: null },
	])('round-trips the $kind queue pause variant', (pause) => {
		const parsed = parseServerWsMessage({
			type: 'chat-execution-control-updated',
			chatId: '123',
			control: control({
				queue: {
					entries: [
						{
							id: 'ok',
							content: 'hello',
							revision: 1,
							createdAt: installedAt,
							updatedAt: installedAt,
						},
					],
					dispatchingEntryId: null,
					recentlyDispatched: [],
					pause,
				},
			}),
		});

		expect(parsed).toBeInstanceOf(ChatExecutionControlUpdatedMessage);
		if (!(parsed instanceof ChatExecutionControlUpdatedMessage)) return;
		expect(parsed.control.queue.pause).toEqual(pause);
	});

	it.each([
		{ id: 'not-a-uuid', installedAt },
		{ id: continuationId, installedAt: 'invalid' },
		undefined,
	])('rejects malformed continuation state %#', (recoveredInputContinuation) => {
		expect(
			parseServerWsMessage({
				type: 'chat-execution-control-updated',
				chatId: '123',
				control: control({ recoveredInputContinuation }),
			}),
		).toBeNull();
	});

	it('rejects malformed queue entries rather than partially applying a snapshot', () => {
		expect(
			parseServerWsMessage({
				type: 'chat-execution-control-updated',
				chatId: '123',
				control: control({
					queue: {
						entries: [
							{
								id: 1,
								content: 'bad',
								revision: 1,
								createdAt: installedAt,
								updatedAt: installedAt,
							},
						],
						dispatchingEntryId: null,
						recentlyDispatched: [],
						pause: null,
					},
				}),
			}),
		).toBeNull();
	});

	it('preserves dispatch identity and recent dispatch markers', () => {
		const parsed = parseServerWsMessage({
			type: 'chat-execution-control-updated',
			chatId: '123',
			control: control({
				queue: {
					entries: [],
					dispatchingEntryId: 'entry-1',
					recentlyDispatched: [{ entryId: 'entry-1', dispatchedAt: installedAt }],
					pause: null,
				},
			}),
		});

		expect(parsed).toBeInstanceOf(ChatExecutionControlUpdatedMessage);
		if (!(parsed instanceof ChatExecutionControlUpdatedMessage)) return;
		expect(parsed.control.queue.dispatchingEntryId).toBe('entry-1');
		expect(parsed.control.queue.recentlyDispatched).toEqual([
			{ entryId: 'entry-1', dispatchedAt: installedAt },
		]);
	});
});
