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
		appendServerNotice: vi.fn(),
		setIsSystemChatChange: vi.fn(),
		conversationUi: {
			clearPendingPermissionsForChat: vi.fn(),
			clearTurnPermissionRequestsForChat: vi.fn(),
		},
		clearTurnStatus: vi.fn(),
		isChatProcessing: vi.fn(() => false),
		onNavigateToChat: vi.fn(),
		getPendingChatId: () => null,
		clearPendingChatId: vi.fn(),
		markChatTranscriptValidated: vi.fn(),
		notifyCompletion: vi.fn(),
		...overrides,
	};
}

describe('handleAgentComplete', () => {
	it('marks transcript validated instead of deleting on successful completion', () => {
		const ctx = createCtx();
		handleAgentComplete(new AgentRunFinishedMessage('chat-1', 0), ctx);
		expect(ctx.markChatTranscriptValidated).toHaveBeenCalledWith('chat-1');
	});

	it('notifies on successful completion', () => {
		const ctx = createCtx();
		handleAgentComplete(new AgentRunFinishedMessage('chat-1', 0), ctx);
		expect(ctx.notifyCompletion).toHaveBeenCalledOnce();
	});

	it('does not notify or mark validated when exitCode is 1', () => {
		const ctx = createCtx();
		handleAgentComplete(new AgentRunFinishedMessage('chat-1', 1), ctx);
		expect(ctx.markChatTranscriptValidated).not.toHaveBeenCalled();
		expect(ctx.notifyCompletion).not.toHaveBeenCalled();
	});

	it.each([2, 127, undefined])(
		'preserves existing completion handling without notifying when exitCode is %s',
		(exitCode) => {
			const ctx = createCtx();
			handleAgentComplete(new AgentRunFinishedMessage('chat-1', exitCode), ctx);
			expect(ctx.markChatTranscriptValidated).toHaveBeenCalledWith('chat-1');
			expect(ctx.notifyCompletion).not.toHaveBeenCalled();
		},
	);

	it('does not notify when the turn was interrupted', () => {
		const ctx = createCtx();
		handleAgentComplete(
			new AgentRunFinishedMessage('chat-1', 0, undefined, undefined, undefined, 'interrupted'),
			ctx,
		);

		expect(ctx.markChatTranscriptValidated).toHaveBeenCalledWith('chat-1');
		expect(ctx.notifyCompletion).not.toHaveBeenCalled();
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
		expect(ctx.conversationUi.clearTurnPermissionRequestsForChat).not.toHaveBeenCalled();
		expect(ctx.notifyCompletion).not.toHaveBeenCalled();
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
		const clearTurnPermissionRequestsForChat = vi.fn();
		const ctx = createCtx({
			conversationUi: {
				clearPendingPermissionsForChat: vi.fn(),
				clearTurnPermissionRequestsForChat,
			},
		});
		handleAgentComplete(new AgentRunFinishedMessage('chat-1', 0), ctx);

		expect(clearTurnPermissionRequestsForChat).toHaveBeenCalledWith('chat-1');
	});

	it('clears only the completed chat permissions when another chat is current', () => {
		const clearTurnPermissionRequestsForChat = vi.fn();
		const ctx = createCtx({
			getCurrentChatId: () => 'chat-current',
			conversationUi: {
				clearPendingPermissionsForChat: vi.fn(),
				clearTurnPermissionRequestsForChat,
			},
		});

		handleAgentComplete(new AgentRunFinishedMessage('chat-completed', 0), ctx);

		expect(clearTurnPermissionRequestsForChat).toHaveBeenCalledWith('chat-completed');
		expect(clearTurnPermissionRequestsForChat).not.toHaveBeenCalledWith('chat-current');
	});
});

describe('handleAgentError', () => {
	it('clears selected-turn metadata and appends the error to its own chat', () => {
		const ctx = createCtx();
		handleAgentError(new AgentRunFailedMessage('chat-1', 'Something broke'), ctx);

		expect(ctx.clearTurnStatus).toHaveBeenCalledWith('chat-1');
		expect(ctx.appendServerNotice).toHaveBeenCalledWith('chat-1', 'error', 'Something broke');
		expect(ctx.conversationUi.clearPendingPermissionsForChat).toHaveBeenCalledWith('chat-1');
	});

	it('preserves successor-turn metadata and permission requests', () => {
		const ctx = createCtx({ isChatProcessing: () => true });

		handleAgentError(new AgentRunFailedMessage('chat-1', 'Previous turn failed'), ctx);

		expect(ctx.clearTurnStatus).not.toHaveBeenCalled();
		expect(ctx.conversationUi.clearPendingPermissionsForChat).not.toHaveBeenCalled();
	});

	it('clears only the failed chat permissions when another chat is current', () => {
		const clearPendingPermissionsForChat = vi.fn();
		const ctx = createCtx({
			getCurrentChatId: () => 'chat-current',
			conversationUi: {
				clearPendingPermissionsForChat,
				clearTurnPermissionRequestsForChat: vi.fn(),
			},
		});

		handleAgentError(new AgentRunFailedMessage('chat-failed', 'Something broke'), ctx);

		expect(clearPendingPermissionsForChat).toHaveBeenCalledWith('chat-failed');
		expect(clearPendingPermissionsForChat).not.toHaveBeenCalledWith('chat-current');
	});
});
