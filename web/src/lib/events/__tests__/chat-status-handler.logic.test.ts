import { describe, it, expect, vi } from 'vitest';
import { handleChatAborted } from '../handlers/chat';
import { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import type { ChatEventContext } from '../handlers/chat';
import { ChatSessionStoppedMessage } from '$shared/ws-events';

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
		isChatProcessing: vi.fn(() => false),
		startupCoordinator: new StartupCoordinator(),
		onExternalChatCreated: vi.fn(),
		getPendingChatId: vi.fn().mockReturnValue(null),
		setPendingChatId: vi.fn(),
		clearPendingChatId: vi.fn(),
		...overrides,
	};
}

describe('handleChatAborted', () => {
	it('preserves successor-turn metadata and permission requests', () => {
		const ctx = makeCtx({
			getCurrentChatId: () => 'chat-a',
			isChatProcessing: () => true,
		});

		handleChatAborted(
			new ChatSessionStoppedMessage('chat-a', 'interrupt-requested', 'interrupt-and-send'),
			ctx,
		);

		expect(ctx.conversationUi.clearPendingPermissionRequests).not.toHaveBeenCalled();
		expect(ctx.appendLocalNotice).not.toHaveBeenCalled();
	});

	it('leaves lifecycle cleanup to processing phases after plain Stop acknowledgement', () => {
		const ctx = makeCtx({
			getCurrentChatId: () => 'chat-a',
			isChatProcessing: () => true,
		});

		handleChatAborted(
			new ChatSessionStoppedMessage('chat-a', 'interrupt-requested', 'stop'),
			ctx,
		);

		expect(ctx.conversationUi.clearPendingPermissionRequests).not.toHaveBeenCalled();
		expect(ctx.appendLocalNotice).toHaveBeenCalledWith('warning', 'Chat interrupted by user.');
	});

	it('does not report an already-idle Stop as an interruption', () => {
		const ctx = makeCtx({ getCurrentChatId: () => 'chat-a' });

		handleChatAborted(
			new ChatSessionStoppedMessage('chat-a', 'already-idle', 'stop'),
			ctx,
		);

		expect(ctx.appendLocalNotice).not.toHaveBeenCalled();
		expect(ctx.conversationUi.clearPendingPermissionRequests).not.toHaveBeenCalled();
	});
});
