import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module before importing the store.
vi.mock('$lib/api/chats', () => ({
	markChatsReadBatch: vi.fn(),
}));

import { ReadReceiptOutboxStore } from '../read-receipt-outbox.svelte';
import { ChatSessionsStore } from '../chat-sessions.svelte';
import { markChatsReadBatch } from '$lib/api/chats';

const mockMarkBatch = vi.mocked(markChatsReadBatch);

function createTestStore() {
	const sessions = new ChatSessionsStore();
	const outbox = new ReadReceiptOutboxStore(sessions);
	return { sessions, outbox };
}

describe('ReadReceiptOutboxStore', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockMarkBatch.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('merges timestamps via max per chatId', () => {
		const { outbox } = createTestStore();

		outbox.enqueue('a', '2026-02-25T10:00:00.000Z');
		outbox.enqueue('a', '2026-02-25T12:00:00.000Z');
		outbox.enqueue('a', '2026-02-25T11:00:00.000Z');

		expect(outbox.pendingByChatId['a']).toBe('2026-02-25T12:00:00.000Z');
	});

	it('debounces at least 2s before flush', async () => {
		const { outbox } = createTestStore();
		mockMarkBatch.mockResolvedValue({ success: true, results: [] });

		outbox.enqueue('a', '2026-02-25T10:00:00.000Z');

		// Advance by 1s -- should not have flushed yet.
		await vi.advanceTimersByTimeAsync(1000);
		expect(mockMarkBatch).not.toHaveBeenCalled();

		// Advance to 2s -- should flush.
		await vi.advanceTimersByTimeAsync(1000);
		expect(mockMarkBatch).toHaveBeenCalledTimes(1);
	});

	it('maxWait forces flush at 10s even with continuous enqueues', async () => {
		const { outbox } = createTestStore();
		mockMarkBatch.mockResolvedValue({ success: true, results: [] });

		// Enqueue repeatedly, each time resetting the debounce.
		for (let i = 0; i < 10; i++) {
			outbox.enqueue('a', `2026-02-25T10:0${i}:00.000Z`);
			await vi.advanceTimersByTimeAsync(1500);
		}

		// After 15s of enqueues (10 * 1.5s), maxWait should have forced at least one flush.
		expect(mockMarkBatch).toHaveBeenCalled();
	});

	it('flushNow bypasses debounce', async () => {
		const { outbox } = createTestStore();
		mockMarkBatch.mockResolvedValue({ success: true, results: [
			{ chatId: 'a', lastReadAt: '2026-02-25T10:00:00.000Z' },
		] });

		outbox.enqueue('a', '2026-02-25T10:00:00.000Z');
		await outbox.flushNow();

		expect(mockMarkBatch).toHaveBeenCalledTimes(1);
	});

	it('acknowledged entries cleared after success', async () => {
		const { outbox, sessions } = createTestStore();

		// Set up sessions with the chat so patchLastReadAt works.
		sessions.upsertFromServer([{
			id: 'a',
			provider: 'claude',
			model: 'opus',
			title: 'A',
			projectPath: '/p',
			tags: [],
			native: { path: null },
			activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
			preview: { lastMessage: '' },
			isPinned: false,
			isArchived: false,
			isActive: false,
			isUnread: true,
		}]);

		mockMarkBatch.mockResolvedValue({
			success: true,
			results: [
				{ chatId: 'a', lastReadAt: '2026-02-25T10:00:00.000Z' },
			],
		});

		outbox.enqueue('a', '2026-02-25T10:00:00.000Z');
		await outbox.flushNow();

		expect(outbox.pendingByChatId['a']).toBeUndefined();
		expect(sessions.byId['a']?.isUnread).toBe(false);
	});

	it('retries with backoff on failure', async () => {
		const { outbox } = createTestStore();
		mockMarkBatch.mockRejectedValue(new Error('Network error'));

		outbox.enqueue('a', '2026-02-25T10:00:00.000Z');
		await outbox.flushNow();

		// Pending entry should still exist.
		expect(outbox.pendingByChatId['a']).toBe('2026-02-25T10:00:00.000Z');
		expect(outbox.retryIndex).toBe(1);

		// Retry timer should be set (2s for first retry).
		mockMarkBatch.mockResolvedValue({ success: true, results: [
			{ chatId: 'a', lastReadAt: '2026-02-25T10:00:00.000Z' },
		] });

		await vi.advanceTimersByTimeAsync(2000);
		expect(mockMarkBatch).toHaveBeenCalledTimes(2);
	});
});
