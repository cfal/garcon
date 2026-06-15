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
