import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
	handleChatTitle,
	handleChatDeleted,
	handleChatReadUpdated,
	handleChatProjectPathUpdated,
	handleChatListInvalidated,
} from '../handlers/sidebar';
import type { SidebarContext } from '../handlers/sidebar';
import {
	ChatTitleUpdatedMessage,
	ChatSessionDeletedWsMessage,
	ChatReadUpdatedV1Message,
	ChatProjectPathUpdatedMessage,
	ChatListRefreshRequestedMessage,
} from '$shared/ws-events';

interface SidebarContextMocks extends SidebarContext {
	removeChat: Mock<(chatId: string) => void>;
	navigateAwayFromChat: Mock<(chatId: string) => void>;
	patchChatTitle: Mock<(chatId: string, title: string) => void>;
	patchChatProjectPath: Mock<(chatId: string, projectPath: string) => void>;
	patchLastReadAt: Mock<(chatId: string, lastReadAt: string) => void>;
	refreshChats: Mock<() => void>;
	removeChatTranscript?: Mock<(chatId: string) => void>;
}

function createSidebarContext(
	overrides: Partial<SidebarContextMocks> = {},
): SidebarContextMocks {
	const context: SidebarContextMocks = {
		removeChat: vi.fn<(chatId: string) => void>(),
		navigateAwayFromChat: vi.fn<(chatId: string) => void>(),
		patchChatTitle: vi.fn<(chatId: string, title: string) => void>(),
		patchChatProjectPath: vi.fn<(chatId: string, projectPath: string) => void>(),
		patchLastReadAt: vi.fn<(chatId: string, lastReadAt: string) => void>(),
		refreshChats: vi.fn<() => void>(),
		...overrides,
	};
	return context;
}

describe('handleChatTitle', () => {
	it('patches the title for a valid message', () => {
		const ctx = createSidebarContext();

		handleChatTitle(new ChatTitleUpdatedMessage('chat-1', 'New Title'), ctx);

		expect(ctx.patchChatTitle).toHaveBeenCalledWith('chat-1', 'New Title');
	});

	it('does nothing when chatId is missing', () => {
		const ctx = createSidebarContext();

		handleChatTitle(new ChatTitleUpdatedMessage('', 'New Title'), ctx);

		expect(ctx.patchChatTitle).not.toHaveBeenCalled();
	});

	it('does nothing when title is missing', () => {
		const ctx = createSidebarContext();

		handleChatTitle(new ChatTitleUpdatedMessage('chat-1', ''), ctx);

		expect(ctx.patchChatTitle).not.toHaveBeenCalled();
	});
});

describe('handleChatDeleted', () => {
	it('navigates away then removes the chat transcript', () => {
		const ctx = createSidebarContext({ removeChatTranscript: vi.fn() });

		handleChatDeleted(new ChatSessionDeletedWsMessage('chat-1'), ctx);

		expect(ctx.navigateAwayFromChat).toHaveBeenCalledWith('chat-1');
		expect(ctx.removeChat).toHaveBeenCalledWith('chat-1');
		expect(ctx.removeChatTranscript).toHaveBeenCalledWith('chat-1');
		// Navigate must happen before remove so the order lookup works.
		const navOrder = ctx.navigateAwayFromChat.mock.invocationCallOrder[0];
		const removeOrder = ctx.removeChat.mock.invocationCallOrder[0];
		expect(navOrder).toBeLessThan(removeOrder);
	});

	it('does nothing when chatId is missing', () => {
		const ctx = createSidebarContext({ removeChatTranscript: vi.fn() });

		handleChatDeleted(new ChatSessionDeletedWsMessage(''), ctx);

		expect(ctx.navigateAwayFromChat).not.toHaveBeenCalled();
		expect(ctx.removeChat).not.toHaveBeenCalled();
		expect(ctx.removeChatTranscript).not.toHaveBeenCalled();
	});
});

describe('handleChatReadUpdated', () => {
	it('calls patchLastReadAt with correct args', () => {
		const ctx = createSidebarContext();

		handleChatReadUpdated(new ChatReadUpdatedV1Message('chat-1', '2026-02-25T12:00:00.000Z'), ctx);

		expect(ctx.patchLastReadAt).toHaveBeenCalledWith('chat-1', '2026-02-25T12:00:00.000Z');
	});

	it('does nothing when chatId is missing', () => {
		const ctx = createSidebarContext();

		handleChatReadUpdated(new ChatReadUpdatedV1Message('', '2026-02-25T12:00:00.000Z'), ctx);

		expect(ctx.patchLastReadAt).not.toHaveBeenCalled();
	});
});

describe('handleChatProjectPathUpdated', () => {
	it('patches the project path for a valid message', () => {
		const ctx = createSidebarContext();

		handleChatProjectPathUpdated(
			new ChatProjectPathUpdatedMessage('chat-1', '/workspace/worktree', '/workspace/repo'),
			ctx,
		);

		expect(ctx.patchChatProjectPath).toHaveBeenCalledWith('chat-1', '/workspace/worktree');
	});

	it('does nothing when chatId is missing', () => {
		const ctx = createSidebarContext();

		handleChatProjectPathUpdated(
			new ChatProjectPathUpdatedMessage('', '/workspace/worktree', '/workspace/repo'),
			ctx,
		);

		expect(ctx.patchChatProjectPath).not.toHaveBeenCalled();
	});
});

describe('handleChatListInvalidated', () => {
	it('calls refreshChats when chatId is present', () => {
		const ctx = createSidebarContext();

		handleChatListInvalidated(new ChatListRefreshRequestedMessage('pinned-toggled', 'chat-1'), ctx);

		expect(ctx.refreshChats).toHaveBeenCalledTimes(1);
	});

	it('does nothing when chatId is missing', () => {
		const ctx = createSidebarContext();

		handleChatListInvalidated(new ChatListRefreshRequestedMessage('archive-toggled', ''), ctx);

		expect(ctx.refreshChats).not.toHaveBeenCalled();
	});
});
