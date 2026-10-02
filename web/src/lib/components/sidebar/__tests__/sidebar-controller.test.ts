import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SidebarController, type SidebarControllerDeps } from '../sidebar-controller.svelte';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';

vi.mock('$lib/api/chats.js', () => ({
	togglePinned: vi.fn(),
	toggleArchive: vi.fn(),
	deleteChat: vi.fn(),
	reorderChat: vi.fn(),
	sortChatOrder: vi.fn(),
	getChatDetails: vi.fn(),
	setChatTags: vi.fn(),
}));

import {
	togglePinned,
	toggleArchive,
	reorderChat,
	sortChatOrder,

} from '$lib/api/chats.js';

const mockTogglePinned = vi.mocked(togglePinned);
const mockToggleArchive = vi.mocked(toggleArchive);
const mockReorderChat = vi.mocked(reorderChat);
const mockSortChatOrder = vi.mocked(sortChatOrder);

function makeChat(overrides: Partial<ChatSessionRecord>): ChatSessionRecord {
	return {
		id: 'c-1',
		projectPath: '/tmp/project',
		orderGroup: 'normal',
		title: 'Chat',
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'draft',
		tags: [],
		...overrides,
		parentChat: overrides.parentChat ?? null,
		agentOwnershipEpoch: overrides.agentOwnershipEpoch ?? null,
	};
}

describe('SidebarController', () => {
	let quietRefresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
	let deps: SidebarControllerDeps;
	let controller: SidebarController;

	beforeEach(() => {
		vi.clearAllMocks();
		quietRefresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const startArchiveMutation = (chatIds: readonly string[]) => ({
			chatIds: [...chatIds],
			completion: Promise.all(chatIds.map((chatId) => mockToggleArchive(chatId))).then(async () => {
				await quietRefresh();
			}),
		});
		deps = {
			get onQuietRefresh() {
				return quietRefresh;
			},
			get isArchiveMutationPending() {
				return () => false;
			},
			get startArchivingChats() {
				return startArchiveMutation;
			},
			get startUnarchivingChats() {
				return startArchiveMutation;
			},
		};
		controller = new SidebarController(deps);
	});

	describe('reorderChat', () => {
		it('passes an after placement and refreshes', async () => {
			mockReorderChat.mockResolvedValue({
				success: true,
				chatId: 'c-2',
				orderGroup: 'normal',
				changed: true,
			});

			await controller.reorderChat('c-2', {
				kind: 'relative',
				referenceChatId: 'c-1',
				position: 'after',
			});

			expect(mockReorderChat).toHaveBeenCalledWith({
				chatId: 'c-2',
				placement: { kind: 'relative', referenceChatId: 'c-1', position: 'after' },
			});
			expect(quietRefresh).toHaveBeenCalledOnce();
		});

		it('does not refresh after a mutation failure', async () => {
			mockReorderChat.mockRejectedValue(new Error('reorder failed'));

			await expect(
				controller.reorderChat('c-2', {
					kind: 'relative',
					referenceChatId: 'c-3',
					position: 'before',
				}),
			).rejects.toThrow('reorder failed');

			expect(quietRefresh).not.toHaveBeenCalled();
		});
	});

	describe('sortChatOrder', () => {
		it('returns the typed response after refreshing', async () => {
			const response = {
				success: true as const,
				sortKey: 'created' as const,
				changed: true,
			};
			mockSortChatOrder.mockResolvedValue(response);

			await expect(controller.sortChatOrder('created')).resolves.toEqual(response);

			expect(mockSortChatOrder).toHaveBeenCalledWith({ sortKey: 'created' });
			expect(quietRefresh).toHaveBeenCalledOnce();
		});

		it('does not refresh after an API failure', async () => {
			mockSortChatOrder.mockRejectedValue(new Error('sort failed'));

			await expect(controller.sortChatOrder('activity')).rejects.toThrow('sort failed');

			expect(quietRefresh).not.toHaveBeenCalled();
		});
	});

	describe('bulk operations', () => {
		it('pins only unpinned selected chats', async () => {
			mockTogglePinned.mockResolvedValue({ success: true, isPinned: true });

			const operation = controller.startBulkOperation('pin', {
				selectedChats: [
					makeChat({ id: 'c-1', isPinned: false }),
					makeChat({ id: 'c-2', isPinned: true }),
				],
				allChats: [],
				displayedChatIds: [],
				selectedChatId: null,
			});

			expect(operation).toMatchObject({
				affectedIds: ['c-1'],
				nextSelectedChatId: null,
				shouldCreateNewChat: false,
			});

			await operation.completion;

			expect(mockTogglePinned).toHaveBeenCalledWith('c-1');
			expect(mockTogglePinned).toHaveBeenCalledTimes(1);
			expect(quietRefresh).toHaveBeenCalledOnce();
		});

		it('plans the next visible chat before archiving the selected chat', async () => {
			mockToggleArchive.mockResolvedValue({ success: true, isArchived: true });
			const operation = controller.startBulkOperation('archive', {
				selectedChats: [makeChat({ id: 'c-1', isArchived: false })],
				allChats: [
					makeChat({ id: 'c-1', isArchived: false }),
					makeChat({ id: 'c-2', isArchived: false }),
				],
				displayedChatIds: ['c-1', 'c-2'],
				selectedChatId: 'c-1',
			});

			expect(operation).toMatchObject({
				affectedIds: ['c-1'],
				nextSelectedChatId: 'c-2',
				shouldCreateNewChat: false,
			});
			await operation.completion;

			expect(mockToggleArchive).toHaveBeenCalledWith('c-1');
		});

		it('plans a new chat when bulk archive removes the last visible chat', () => {
			const operation = controller.startBulkOperation('archive', {
				selectedChats: [makeChat({ id: 'c-1', isArchived: false })],
				allChats: [makeChat({ id: 'c-1', isArchived: false })],
				displayedChatIds: ['c-1'],
				selectedChatId: 'c-1',
			});

			expect(operation).toMatchObject({
				affectedIds: ['c-1'],
				nextSelectedChatId: null,
				shouldCreateNewChat: true,
			});
		});

		it('plans an adjacent survivor from the displayed recent-activity order', async () => {
			mockToggleArchive.mockResolvedValue({ success: true, isArchived: true });
			const operation = controller.startBulkOperation('archive', {
				selectedChats: [makeChat({ id: 'selected', isArchived: false })],
				allChats: [
					makeChat({ id: 'selected', isArchived: false }),
					makeChat({ id: 'manual-order-neighbor', isArchived: false }),
					makeChat({ id: 'recent-order-neighbor', isArchived: false }),
				],
				displayedChatIds: ['manual-order-neighbor', 'selected', 'recent-order-neighbor'],
				selectedChatId: 'selected',
			});

			expect(operation.nextSelectedChatId).toBe('recent-order-neighbor');
			await operation.completion;
		});
	});
});
