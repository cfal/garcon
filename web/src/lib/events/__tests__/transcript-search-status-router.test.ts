import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptSearchStatusRouter } from '../transcript-search-status-router.svelte';
import type { TranscriptSearchStatusV1 } from '$shared/chat-search';

const { drain, cleanup, createDrainCursor } = vi.hoisted(() => {
	const drain = vi.fn();
	const cleanup = vi.fn();
	return {
		drain,
		cleanup,
		createDrainCursor: vi.fn(() => ({ drain, cleanup })),
	};
});

vi.mock('$lib/ws/drain', () => ({ createDrainCursor }));

const status = {
	version: 1,
	phase: 'rebuilding',
	chats: { indexed: 3, pending: 1, failed: 0 },
	queuedJobs: 1,
	resync: { completedChats: 3, totalChats: 4 },
	backlogRows: 12,
	activeChat: { position: 4, total: 10 },
	lastErrorCode: null,
	updatedAt: '2026-08-19T00:00:00.000Z',
} satisfies TranscriptSearchStatusV1;

describe('TranscriptSearchStatusRouter', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		drain.mockReturnValue([]);
		createDrainCursor.mockReturnValue({ drain, cleanup });
	});

	it('forwards only the latest transcript search status in a drain', () => {
		const next = { ...status, chats: { ...status.chats, indexed: 4 } };
		const onStatus = vi.fn();
		drain.mockReturnValue([
			{ data: { type: 'transcript-search-status', status } },
			{ data: { type: 'settings-changed', settings: {} } },
			{ data: { type: 'transcript-search-status', status: next } },
		]);
		const router = new TranscriptSearchStatusRouter({} as never, onStatus);

		router.start();
		router.tick();

		expect(onStatus).toHaveBeenCalledOnce();
		expect(onStatus).toHaveBeenCalledWith(next);
	});

	it('ignores unrelated frames and releases its drain cursor', () => {
		const onStatus = vi.fn();
		drain.mockReturnValue([{ data: { type: 'chat-session-created', chatId: 'chat-1' } }]);
		const router = new TranscriptSearchStatusRouter({} as never, onStatus);

		router.start();
		router.tick();
		router.destroy();

		expect(onStatus).not.toHaveBeenCalled();
		expect(cleanup).toHaveBeenCalledOnce();
	});
});
