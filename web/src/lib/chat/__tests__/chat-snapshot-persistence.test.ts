import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import type { ChatMessageEvent } from '$shared/chat-events';
import { ChatSnapshotPersistence, type ChatSnapshotDraft } from '../chat-snapshot-persistence';

const TS = '2026-06-01T00:00:00.000Z';

function event(seq: number): ChatMessageEvent {
	return {
		appendSeq: seq,
		seq,
		messageId: `message-${seq}`,
		rev: 1,
		message: new AssistantMessage(TS, `message ${seq}`),
	};
}

function draft(chatId: string, lastAppendSeq: number): ChatSnapshotDraft {
	return {
		chatId,
		entries: [event(lastAppendSeq)],
		logId: `log-${chatId}`,
		lastAppendSeq,
	};
}

describe('ChatSnapshotPersistence', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('calls default timers with the global receiver', () => {
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		const timerHandle = 1 as unknown as ReturnType<typeof setTimeout>;
		const scheduled: { callback?: () => void } = {};

		const setTimeoutMock = vi.fn(function (
			this: typeof globalThis,
			callback: () => void,
			delayMs?: number,
		) {
			expect(this).toBe(globalThis);
			expect(delayMs).toBe(100);
			scheduled.callback = callback;
			return timerHandle;
		});
		const clearTimeoutMock = vi.fn(function (
			this: typeof globalThis,
			handle: ReturnType<typeof setTimeout>,
		) {
			expect(this).toBe(globalThis);
			expect(handle).toBe(timerHandle);
		});

		globalThis.setTimeout = setTimeoutMock as unknown as typeof setTimeout;
		globalThis.clearTimeout = clearTimeoutMock as unknown as typeof clearTimeout;

		try {
			const persist = vi.fn();
			const persistence = new ChatSnapshotPersistence({ delayMs: 100, persist });
			persistence.schedule(draft('chat-1', 1));

			expect(setTimeoutMock).toHaveBeenCalledOnce();
			expect(scheduled.callback).toEqual(expect.any(Function));

			scheduled.callback?.();
			expect(clearTimeoutMock).toHaveBeenCalledOnce();
			expect(persist).toHaveBeenCalledOnce();
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	});

	it('debounces repeated snapshots for the same chat', () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		const persistence = new ChatSnapshotPersistence({ delayMs: 100, persist });

		persistence.schedule(draft('chat-1', 1));
		persistence.schedule(draft('chat-1', 2));
		vi.advanceTimersByTime(99);

		expect(persist).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(persist).toHaveBeenCalledOnce();
		expect(persist).toHaveBeenCalledWith(expect.objectContaining({
			chatId: 'chat-1',
			lastAppendSeq: 2,
		}));
	});

	it('flushes the previous chat before replacing the pending draft', () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		const persistence = new ChatSnapshotPersistence({ delayMs: 100, persist });

		persistence.schedule(draft('chat-1', 1));
		persistence.schedule(draft('chat-2', 5));

		expect(persist).toHaveBeenCalledOnce();
		expect(persist).toHaveBeenCalledWith(expect.objectContaining({
			chatId: 'chat-1',
			lastAppendSeq: 1,
		}));

		vi.advanceTimersByTime(100);
		expect(persist).toHaveBeenCalledTimes(2);
		expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({
			chatId: 'chat-2',
			lastAppendSeq: 5,
		}));
	});

	it('flushes the pending draft on dispose without duplicating timer persistence', () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		const persistence = new ChatSnapshotPersistence({ delayMs: 100, persist });

		persistence.schedule(draft('chat-1', 3));
		persistence.dispose();
		vi.advanceTimersByTime(100);

		expect(persist).toHaveBeenCalledOnce();
		expect(persist).toHaveBeenCalledWith(expect.objectContaining({
			chatId: 'chat-1',
			lastAppendSeq: 3,
		}));
	});
});
