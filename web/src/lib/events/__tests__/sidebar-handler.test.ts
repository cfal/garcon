import { describe, expect, it, vi } from 'vitest';
import { handleChatTitle, handleChatDeleted, handleChatReadUpdated, handleChatListInvalidated } from '../handlers/sidebar';
import { ChatTitleUpdatedMessage, ChatSessionDeletedWsMessage, ChatReadUpdatedV1Message, ChatListRefreshRequestedMessage } from '$shared/ws-events';

describe('handleChatTitle', () => {
	it('patches the title for a valid message', () => {
		const ctx = {
			removeChat: vi.fn(),
			navigateAwayFromChat: vi.fn(),
			patchChatTitle: vi.fn(),
			patchLastReadAt: vi.fn(),
			refreshChats: vi.fn(),
		};

		handleChatTitle(
			new ChatTitleUpdatedMessage('chat-1', 'New Title'),
			ctx,
		);

		expect(ctx.patchChatTitle).toHaveBeenCalledWith('chat-1', 'New Title');
	});

	it('does nothing when chatId is missing', () => {
		const ctx = {
			removeChat: vi.fn(),
			navigateAwayFromChat: vi.fn(),
			patchChatTitle: vi.fn(),
			patchLastReadAt: vi.fn(),
			refreshChats: vi.fn(),
		};

		handleChatTitle(
			new ChatTitleUpdatedMessage('', 'New Title'),
			ctx,
		);

		expect(ctx.patchChatTitle).not.toHaveBeenCalled();
	});

	it('does nothing when title is missing', () => {
		const ctx = {
			removeChat: vi.fn(),
			navigateAwayFromChat: vi.fn(),
			patchChatTitle: vi.fn(),
			patchLastReadAt: vi.fn(),
			refreshChats: vi.fn(),
		};

		handleChatTitle(
			new ChatTitleUpdatedMessage('chat-1', ''),
			ctx,
		);

		expect(ctx.patchChatTitle).not.toHaveBeenCalled();
	});
});

describe('handleChatDeleted', () => {
	it('navigates away then removes the chat and snapshot', () => {
		const ctx = {
			removeChat: vi.fn(),
			navigateAwayFromChat: vi.fn(),
			patchChatTitle: vi.fn(),
			patchLastReadAt: vi.fn(),
			refreshChats: vi.fn(),
			removeChatSnapshot: vi.fn(),
		};

		handleChatDeleted(
			new ChatSessionDeletedWsMessage('chat-1'),
			ctx,
		);

		expect(ctx.navigateAwayFromChat).toHaveBeenCalledWith('chat-1');
		expect(ctx.removeChat).toHaveBeenCalledWith('chat-1');
		expect(ctx.removeChatSnapshot).toHaveBeenCalledWith('chat-1');
		// Navigate must happen before remove so the order lookup works.
		const navOrder = ctx.navigateAwayFromChat.mock.invocationCallOrder[0];
		const removeOrder = ctx.removeChat.mock.invocationCallOrder[0];
		expect(navOrder).toBeLessThan(removeOrder);
	});

	it('does nothing when chatId is missing', () => {
		const ctx = {
			removeChat: vi.fn(),
			navigateAwayFromChat: vi.fn(),
			patchChatTitle: vi.fn(),
			patchLastReadAt: vi.fn(),
			refreshChats: vi.fn(),
			removeChatSnapshot: vi.fn(),
		};

		handleChatDeleted(
			new ChatSessionDeletedWsMessage(''),
			ctx,
		);

		expect(ctx.navigateAwayFromChat).not.toHaveBeenCalled();
		expect(ctx.removeChat).not.toHaveBeenCalled();
		expect(ctx.removeChatSnapshot).not.toHaveBeenCalled();
	});
});

describe('handleChatReadUpdated', () => {
	it('calls patchLastReadAt with correct args', () => {
		const ctx = {
			removeChat: vi.fn(),
			navigateAwayFromChat: vi.fn(),
			patchChatTitle: vi.fn(),
			patchLastReadAt: vi.fn(),
			refreshChats: vi.fn(),
		};

		handleChatReadUpdated(
			new ChatReadUpdatedV1Message('chat-1', '2026-02-25T12:00:00.000Z'),
			ctx,
		);

		expect(ctx.patchLastReadAt).toHaveBeenCalledWith('chat-1', '2026-02-25T12:00:00.000Z');
	});

	it('does nothing when chatId is missing', () => {
		const ctx = {
			removeChat: vi.fn(),
			navigateAwayFromChat: vi.fn(),
			patchChatTitle: vi.fn(),
			patchLastReadAt: vi.fn(),
			refreshChats: vi.fn(),
		};

		handleChatReadUpdated(
			new ChatReadUpdatedV1Message('', '2026-02-25T12:00:00.000Z'),
			ctx,
		);

		expect(ctx.patchLastReadAt).not.toHaveBeenCalled();
	});
});

describe('handleChatListInvalidated', () => {
	it('calls refreshChats when chatId is present', () => {
		const ctx = {
			removeChat: vi.fn(),
			navigateAwayFromChat: vi.fn(),
			patchChatTitle: vi.fn(),
			patchLastReadAt: vi.fn(),
			refreshChats: vi.fn(),
		};

		handleChatListInvalidated(
			new ChatListRefreshRequestedMessage('pinned-toggled', 'chat-1'),
			ctx,
		);

		expect(ctx.refreshChats).toHaveBeenCalledTimes(1);
	});

	it('does nothing when chatId is missing', () => {
		const ctx = {
			removeChat: vi.fn(),
			navigateAwayFromChat: vi.fn(),
			patchChatTitle: vi.fn(),
			patchLastReadAt: vi.fn(),
			refreshChats: vi.fn(),
		};

		handleChatListInvalidated(
			new ChatListRefreshRequestedMessage('archive-toggled', ''),
			ctx,
		);

		expect(ctx.refreshChats).not.toHaveBeenCalled();
	});
});
