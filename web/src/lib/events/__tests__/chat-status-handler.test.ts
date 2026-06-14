import { describe, it, expect, vi } from 'vitest';
import { handleChatStatus } from '../handlers/chat';
import { StartupCoordinator } from '$lib/chat/startup-coordinator';
import type { ChatEventContext } from '../handlers/chat';
import { ChatProcessingUpdatedMessage } from '$shared/ws-events';

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
		appendErrorMessage: vi.fn(),
		appendLocalAssistantMessage: vi.fn(),
		setIsSystemChatChange: vi.fn(),
		conversationUi: makeConversationUi(),
		activateLoadingFor: vi.fn(),
		clearLoadingIndicators: vi.fn(),
		markChatsAsCompleted: vi.fn(),
		setCanAbort: vi.fn(),
		startupCoordinator: new StartupCoordinator(),
		onChatProcessing: vi.fn(),
		onChatNotProcessing: vi.fn(),
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

		expect(ctx.activateLoadingFor).not.toHaveBeenCalled();
	});

	it('activates loading for the current chat when processing', () => {
		const ctx = makeCtx({ getCurrentChatId: () => 'chat-a' });
		handleChatStatus(makeMsg('chat-a', true), ctx);

		expect(ctx.activateLoadingFor).toHaveBeenCalledWith('chat-a');
		expect(ctx.setCanAbort).toHaveBeenCalledWith(true);
	});

	it('clears loading when processing stops', () => {
		const ctx = makeCtx({ getCurrentChatId: () => 'chat-a' });
		handleChatStatus(makeMsg('chat-a', false), ctx);

		expect(ctx.clearLoadingIndicators).toHaveBeenCalledWith('chat-a');
	});

	it('fires onChatProcessing/onChatNotProcessing callbacks', () => {
		const ctx = makeCtx({ getCurrentChatId: () => 'chat-a' });

		handleChatStatus(makeMsg('chat-a', true), ctx);
		expect(ctx.onChatProcessing).toHaveBeenCalledWith('chat-a');

		handleChatStatus(makeMsg('chat-a', false), ctx);
		expect(ctx.onChatNotProcessing).toHaveBeenCalledWith('chat-a');
	});

});
