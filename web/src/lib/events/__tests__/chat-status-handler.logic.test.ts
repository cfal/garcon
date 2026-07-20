import { describe, it, expect, vi } from 'vitest';
import { handleChatAborted, handleChatStatus } from '../handlers/chat';
import { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import type { ChatEventContext } from '../handlers/chat';
import { ChatProcessingUpdatedMessage, ChatSessionStoppedMessage } from '$shared/ws-events';

function makeConversationUi(): ChatEventContext['conversationUi'] {
	return {
		pendingViewChat: null,
		setPendingViewChat: vi.fn(),
		setPendingPermissionRequests: vi.fn(),
		clearPendingPermissionRequests: vi.fn(),
	};
}

function makeCtx(overrides: Partial<ChatEventContext> = {}): ChatEventContext {
	return {
		getSelectedChat: () => null,
		getCurrentChatId: () => null,
		setCurrentChatId: vi.fn(),
		appendLocalNotice: vi.fn(),
		conversationUi: makeConversationUi(),
		markTurnRunning: vi.fn(),
		clearTurnStatus: vi.fn(),
		isChatProcessing: vi.fn(() => false),
		startupCoordinator: new StartupCoordinator(),
		onChatProcessing: vi.fn(),
		onChatNotProcessing: vi.fn(),
		onExternalChatCreated: vi.fn(),
		getPendingChatId: vi.fn().mockReturnValue(null),
		setPendingChatId: vi.fn(),
		clearPendingChatId: vi.fn(),
		...overrides,
	};
}

function makeMsg(chatId: string, isProcessing: boolean): ChatProcessingUpdatedMessage {
	return new ChatProcessingUpdatedMessage(chatId, isProcessing);
}

describe('handleChatStatus', () => {
	it('ignores status updates for other chats', () => {
		const ctx = makeCtx({ getCurrentChatId: () => 'chat-a' });
		handleChatStatus(makeMsg('chat-b', false), ctx);

		expect(ctx.markTurnRunning).not.toHaveBeenCalled();
		expect(ctx.clearTurnStatus).not.toHaveBeenCalled();
	});

	it('marks the selected turn running when processing starts', () => {
		const ctx = makeCtx({ getCurrentChatId: () => 'chat-a' });
		handleChatStatus(makeMsg('chat-a', true), ctx);

		expect(ctx.markTurnRunning).toHaveBeenCalledWith('chat-a');
	});

	it('clears selected-turn metadata when processing stops', () => {
		const ctx = makeCtx({ getCurrentChatId: () => 'chat-a' });
		handleChatStatus(makeMsg('chat-a', false), ctx);

		expect(ctx.clearTurnStatus).toHaveBeenCalledWith('chat-a');
	});

	it('fires onChatProcessing/onChatNotProcessing callbacks', () => {
		const ctx = makeCtx({ getCurrentChatId: () => 'chat-a' });

		handleChatStatus(makeMsg('chat-a', true), ctx);
		expect(ctx.onChatProcessing).toHaveBeenCalledWith('chat-a');

		handleChatStatus(makeMsg('chat-a', false), ctx);
		expect(ctx.onChatNotProcessing).toHaveBeenCalledWith('chat-a');
	});
});

describe('handleChatAborted', () => {
	it('preserves successor-turn metadata and permission requests', () => {
		const ctx = makeCtx({
			getCurrentChatId: () => 'chat-a',
			isChatProcessing: () => true,
		});

		handleChatAborted(
			new ChatSessionStoppedMessage('chat-a', true, 'interrupt-and-send'),
			ctx,
		);

		expect(ctx.clearTurnStatus).not.toHaveBeenCalled();
		expect(ctx.conversationUi.clearPendingPermissionRequests).not.toHaveBeenCalled();
	});

	it('clears stopped-turn metadata before provider processing settles', () => {
		const ctx = makeCtx({
			getCurrentChatId: () => 'chat-a',
			isChatProcessing: () => true,
		});

		handleChatAborted(new ChatSessionStoppedMessage('chat-a', true, 'stop'), ctx);

		expect(ctx.clearTurnStatus).toHaveBeenCalledWith('chat-a');
		expect(ctx.conversationUi.clearPendingPermissionRequests).toHaveBeenCalled();
	});
});
