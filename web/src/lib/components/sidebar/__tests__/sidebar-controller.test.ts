import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SidebarController, type SidebarControllerDeps } from '../sidebar-controller.svelte';

vi.mock('$lib/api/chats.js', () => ({
	togglePinned: vi.fn(),
	toggleArchive: vi.fn(),
	reorderChatsQuick: vi.fn(),
	getChatDetails: vi.fn(),
	forkChat: vi.fn(),
}));

import {
	togglePinned,
	toggleArchive,
	reorderChatsQuick,
	getChatDetails,
	forkChat,
} from '$lib/api/chats.js';

const mockTogglePinned = vi.mocked(togglePinned);
const mockToggleArchive = vi.mocked(toggleArchive);
const mockReorderQuick = vi.mocked(reorderChatsQuick);
const mockGetChatDetails = vi.mocked(getChatDetails);
const mockForkChat = vi.mocked(forkChat);

describe('SidebarController', () => {
	let quietRefresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
	let deps: SidebarControllerDeps;
	let controller: SidebarController;

	beforeEach(() => {
		vi.clearAllMocks();
		quietRefresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		deps = { get onQuietRefresh() { return quietRefresh; } };
		controller = new SidebarController(deps);
	});

	describe('togglePinned', () => {
		it('calls API then refreshes', async () => {
			mockTogglePinned.mockResolvedValue({ success: true, isPinned: true });

			await controller.togglePinned('c-1');

			expect(mockTogglePinned).toHaveBeenCalledWith('c-1');
			expect(quietRefresh).toHaveBeenCalledOnce();
		});

		it('propagates API errors', async () => {
			mockTogglePinned.mockRejectedValue(new Error('fail'));

			await expect(controller.togglePinned('c-1')).rejects.toThrow('fail');
		});
	});

	describe('toggleArchive', () => {
		it('calls API then refreshes', async () => {
			mockToggleArchive.mockResolvedValue({ success: true, isArchived: true });

			await controller.toggleArchive('c-1');

			expect(mockToggleArchive).toHaveBeenCalledWith('c-1');
			expect(quietRefresh).toHaveBeenCalledOnce();
		});
	});

	describe('quickMove', () => {
		it('passes neighbor IDs and refreshes', async () => {
			mockReorderQuick.mockResolvedValue({ success: true });

			await controller.quickMove('c-2', 'c-1', 'c-3');

			expect(mockReorderQuick).toHaveBeenCalledWith({
				chatId: 'c-2',
				chatIdAbove: 'c-1',
				chatIdBelow: 'c-3',
			});
			expect(quietRefresh).toHaveBeenCalledOnce();
		});

		it('handles missing neighbor IDs', async () => {
			mockReorderQuick.mockResolvedValue({ success: true });

			await controller.quickMove('c-2');

			expect(mockReorderQuick).toHaveBeenCalledWith({
				chatId: 'c-2',
				chatIdAbove: undefined,
				chatIdBelow: undefined,
			});
		});
	});

	describe('loadDetails', () => {
		it('returns chat details from API', async () => {
			const details = {
				chatId: 'c-1',
				firstMessage: 'Hello',
				createdAt: '2025-01-01',
				lastActivityAt: '2025-01-02',
				nativePath: '/tmp',
			};
			mockGetChatDetails.mockResolvedValue(details);

			const result = await controller.loadDetails('c-1');

			expect(mockGetChatDetails).toHaveBeenCalledWith('c-1');
			expect(result).toEqual(details);
		});
	});

	describe('forkChat', () => {
		it('forks, refreshes, and returns new chatId', async () => {
			mockForkChat.mockResolvedValue({
				success: true,
				sourceChatId: 'c-1',
				chatId: 'c-fork',
				provider: 'test',
			});

			const result = await controller.forkChat('c-1');

			expect(mockForkChat).toHaveBeenCalledWith(
				expect.objectContaining({ sourceChatId: 'c-1' }),
			);
			expect(quietRefresh).toHaveBeenCalledOnce();
			expect(result).toBe('c-fork');
		});
	});
});
