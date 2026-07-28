import { describe, it, expect, vi } from 'vitest';
import {
	handleAgentComplete,
	handleAgentError,
	type LifecycleContext,
} from '../handlers/lifecycle';
import { AgentRunFinishedMessage, AgentRunFailedMessage } from '$shared/ws-events';

function createCtx(overrides: Partial<LifecycleContext> = {}): LifecycleContext {
	return {
		getCurrentChatId: () => 'chat-1',
		setCurrentChatId: vi.fn(),
		appendLocalNotice: vi.fn(),
		setIsSystemChatChange: vi.fn(),
		conversationUi: {
			clearPendingPermissionRequests: vi.fn(),
			clearTurnPermissionRequests: vi.fn(),
		},
		clearTurnStatus: vi.fn(),
		isChatProcessing: vi.fn(() => false),
		onNavigateToChat: vi.fn(),
		getPendingChatId: () => null,
		clearPendingChatId: vi.fn(),
		markChatTranscriptValidated: vi.fn(),
		...overrides,
	};
}

describe('handleAgentComplete', () => {
	it('marks transcript validated instead of deleting on successful completion', () => {
		const ctx = createCtx();
		handleAgentComplete(new AgentRunFinishedMessage('chat-1', 0), ctx);
		expect(ctx.markChatTranscriptValidated).toHaveBeenCalledWith('chat-1');
	});

	it('does not mark validated when exitCode is 1', () => {
		const ctx = createCtx();
		handleAgentComplete(new AgentRunFinishedMessage('chat-1', 1), ctx);
		expect(ctx.markChatTranscriptValidated).not.toHaveBeenCalled();
	});

	it('clears selected-turn metadata', () => {
		const ctx = createCtx();
		handleAgentComplete(new AgentRunFinishedMessage('chat-1', 0), ctx);
		expect(ctx.clearTurnStatus).toHaveBeenCalledWith('chat-1');
	});

	it('preserves successor-turn metadata and permission requests', () => {
		const ctx = createCtx({ isChatProcessing: () => true });

		handleAgentComplete(new AgentRunFinishedMessage('chat-1', 0), ctx);

		expect(ctx.clearTurnStatus).not.toHaveBeenCalled();
		expect(ctx.conversationUi.clearTurnPermissionRequests).not.toHaveBeenCalled();
	});

	it('navigates to pending chat on success', () => {
		const onNavigateToChat = vi.fn();
		const ctx = createCtx({
			getCurrentChatId: () => null,
			getPendingChatId: () => 'pending-chat',
			onNavigateToChat,
		});

		handleAgentComplete(new AgentRunFinishedMessage('pending-chat', 0), ctx);

		expect(ctx.setCurrentChatId).toHaveBeenCalledWith('pending-chat');
		expect(ctx.setIsSystemChatChange).toHaveBeenCalledWith(true);
		expect(onNavigateToChat).toHaveBeenCalledWith('pending-chat');
		expect(ctx.clearPendingChatId).toHaveBeenCalled();
	});

	it('preserves plan-exit permission requests', () => {
		const clearTurnPermissionRequests = vi.fn();
		const ctx = createCtx({
			conversationUi: {
				clearPendingPermissionRequests: vi.fn(),
				clearTurnPermissionRequests,
			},
		});
		handleAgentComplete(new AgentRunFinishedMessage('chat-1', 0), ctx);

		expect(clearTurnPermissionRequests).toHaveBeenCalledOnce();
	});
});

describe('handleAgentError', () => {
	it('clears selected-turn metadata and appends error message', () => {
		const ctx = createCtx();
		handleAgentError(new AgentRunFailedMessage('chat-1', 'Something broke'), ctx);

		expect(ctx.clearTurnStatus).toHaveBeenCalledWith('chat-1');
		expect(ctx.appendLocalNotice).toHaveBeenCalledWith('error', 'Something broke');
		expect(ctx.conversationUi.clearPendingPermissionRequests).toHaveBeenCalled();
	});

	it('preserves successor-turn metadata and permission requests', () => {
		const ctx = createCtx({ isChatProcessing: () => true });

		handleAgentError(new AgentRunFailedMessage('chat-1', 'Previous turn failed'), ctx);

		expect(ctx.clearTurnStatus).not.toHaveBeenCalled();
		expect(ctx.conversationUi.clearPendingPermissionRequests).not.toHaveBeenCalled();
	});
});
