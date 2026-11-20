import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatTranscriptAppliedCursor } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { OptimisticUserInput, QueuedSteerDelivery } from '$lib/chat/transcript/optimistic-user-input.js';
import { QueuedSteerTranscriptRecovery } from '../queued-steer-transcript-recovery.js';

function fixture() {
	const delivery: QueuedSteerDelivery = {
		clientMessageId: 'input', entryId: 'entry', serverInstanceId: 'server',
		transcriptViewId: 'view', queuedAtVersion: null,
	};
	let inputs: OptimisticUserInput[] = [{
		chatId: 'chat', clientMessageId: delivery.clientMessageId, content: 'guidance',
		createdAt: '2026-01-01T00:00:00.000Z', delivery,
	}];
	const readHead = vi.fn<() => Promise<number | null>>().mockResolvedValue(10);
	const cursor: ChatTranscriptAppliedCursor = { transcriptViewId: 'view', lastOrdinal: 10, stale: false };
	const clear = vi.fn((_chatId: string, id: string) => {
		inputs = inputs.filter(input => input.clientMessageId !== id);
	});
	const recovery = new QueuedSteerTranscriptRecovery({
		inputs: () => inputs,
		cursor: () => cursor,
		clear, readHead,
	});
	return { recovery, readHead, clear, cursor, requeue: () => {
		inputs = inputs.map(input => ({ ...input, delivery: { ...delivery, queuedAtVersion: 10 } }));
	}, remove: () => { inputs = []; } };
}

describe('QueuedSteerTranscriptRecovery', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it.each(['failure', 'unavailable'] as const)('retries a final departure after %s without another control or snapshot', async outcome => {
		const { recovery, readHead, clear } = fixture();
		if (outcome === 'failure') readHead.mockRejectedValueOnce(new Error('offline'));
		else readHead.mockResolvedValueOnce(null);
		recovery.observe('chat');
		await vi.advanceTimersByTimeAsync(0);
		expect(clear).not.toHaveBeenCalled();
		recovery.observe('chat');
		expect(readHead).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(readHead).toHaveBeenCalledTimes(2);
		expect(clear).toHaveBeenCalledWith('chat', 'input');
		expect(vi.getTimerCount()).toBe(0);
		recovery.destroy();
	});

	it.each(['requeue', 'remove', 'destroy'] as const)('does not retry an obsolete departure after %s', async action => {
		const { recovery, readHead, clear, requeue, remove } = fixture();
		readHead.mockRejectedValueOnce(new Error('offline'));
		recovery.observe('chat');
		await vi.advanceTimersByTimeAsync(0);
		if (action === 'requeue') requeue();
		else if (action === 'remove') remove();
		else recovery.destroy();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(readHead).toHaveBeenCalledTimes(1);
		expect(clear).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		recovery.destroy();
	});

	it('bounds retry frequency during an outage and cancels the pending retry on destroy', async () => {
		const { recovery, readHead } = fixture();
		readHead.mockRejectedValue(new Error('offline'));
		recovery.observe('chat');
		await vi.advanceTimersByTimeAsync(30_000);
		expect(readHead).toHaveBeenCalledTimes(6);
		expect(vi.getTimerCount()).toBe(1);
		recovery.destroy();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not retry a read that fails after destruction', async () => {
		const { recovery, readHead } = fixture();
		let reject!: (error: Error) => void;
		readHead.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
		recovery.observe('chat');
		recovery.destroy();
		reject(new Error('offline'));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(readHead).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('retires replaced-view receipts only after validation and stops their retries', async () => {
		const { recovery, readHead, clear, cursor } = fixture();
		readHead.mockRejectedValue(new Error('view replaced'));
		recovery.observe('chat');
		await vi.advanceTimersByTimeAsync(0);
		cursor.transcriptViewId = 'replacement';
		cursor.stale = true;
		recovery.retireCaughtUp('chat');
		expect(clear).not.toHaveBeenCalled();
		cursor.stale = false;
		recovery.retireCaughtUp('chat');
		expect(clear).toHaveBeenCalledWith('chat', 'input');
		await vi.advanceTimersByTimeAsync(60_000);
		expect(readHead).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		recovery.destroy();
	});
});
