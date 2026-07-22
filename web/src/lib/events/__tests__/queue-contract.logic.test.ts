import { describe, expect, it } from 'vitest';
import { ChatExecutionControlUpdatedMessage, parseServerWsMessage } from '$shared/ws-events';

const installedAt = '2026-07-18T00:00:00.000Z';

function control(overrides: Record<string, unknown> = {}) {
	return {
		queue: {
			entries: [],
			dispatchingEntryId: null,
			recentlyDispatched: [],
			pause: null,
			reorderRevision: 0,
		},
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
			control: control(),
		});

		expect(parsed).toBeInstanceOf(ChatExecutionControlUpdatedMessage);
		if (!(parsed instanceof ChatExecutionControlUpdatedMessage)) return;
		expect(parsed.control.version).toBe(7);
		expect(parsed.control.updatedAt).toBe(installedAt);
		expect(parsed.control.queue.entries).toEqual([]);
	});

	it.each([
		{ id: 'manual', kind: 'manual', pausedAt: installedAt },
		{ id: 'failed', kind: 'queued-turn-failed', entryId: 'ok', pausedAt: installedAt },
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
					reorderRevision: 0,
				},
			}),
		});

		expect(parsed).toBeInstanceOf(ChatExecutionControlUpdatedMessage);
		if (!(parsed instanceof ChatExecutionControlUpdatedMessage)) return;
		expect(parsed.control.queue.pause).toEqual(pause);
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
						reorderRevision: 0,
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
					recentlyDispatched: [{ entryId: 'entry-1', revision: 2, dispatchedAt: installedAt }],
					pause: null,
					reorderRevision: 0,
				},
			}),
		});

		expect(parsed).toBeInstanceOf(ChatExecutionControlUpdatedMessage);
		if (!(parsed instanceof ChatExecutionControlUpdatedMessage)) return;
		expect(parsed.control.queue.dispatchingEntryId).toBe('entry-1');
		expect(parsed.control.queue.recentlyDispatched).toEqual([
			{ entryId: 'entry-1', revision: 2, dispatchedAt: installedAt },
		]);
	});
});
