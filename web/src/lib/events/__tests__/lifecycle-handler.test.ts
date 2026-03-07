import { describe, it, expect, vi } from 'vitest';
import { handleAgentComplete, handleAgentError, type LifecycleContext } from '../handlers/lifecycle';
import { AgentRunFinishedMessage, AgentRunFailedMessage } from '$shared/ws-events';

function createCtx(overrides: Partial<LifecycleContext> = {}): LifecycleContext {
	return {
		currentChatId: 'chat-1',
		setCurrentChatId: vi.fn(),
		setChatMessages: vi.fn(),
		setIsSystemChatChange: vi.fn(),
		setPendingPermissionRequests: vi.fn(),
		clearLoadingIndicators: vi.fn(),
		markChatsAsCompleted: vi.fn(),
		getPendingChatId: () => null,
		clearPendingChatId: vi.fn(),
		markChatSnapshotValidated: vi.fn(),
		...overrides,
	};
}

describe('handleAgentComplete', () => {
	it('marks snapshot validated instead of deleting on successful completion', () => {
		const ctx = createCtx();
		handleAgentComplete(new AgentRunFinishedMessage('chat-1', 0), ctx);
		expect(ctx.markChatSnapshotValidated).toHaveBeenCalledWith('chat-1');
	});

	it('does not mark validated when exitCode is 1', () => {
		const ctx = createCtx();
		handleAgentComplete(new AgentRunFinishedMessage('chat-1', 1), ctx);
		expect(ctx.markChatSnapshotValidated).not.toHaveBeenCalled();
	});

	it('clears loading indicators and marks completed', () => {
		const ctx = createCtx();
		handleAgentComplete(new AgentRunFinishedMessage('chat-1', 0), ctx);
		expect(ctx.clearLoadingIndicators).toHaveBeenCalledWith('chat-1');
		expect(ctx.markChatsAsCompleted).toHaveBeenCalledWith('chat-1');
	});

	it('navigates to pending chat on success', () => {
		const onNavigateToChat = vi.fn();
		const ctx = createCtx({
			currentChatId: null,
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
		const setPendingPermissionRequests = vi.fn();
		const ctx = createCtx({ setPendingPermissionRequests });
		handleAgentComplete(new AgentRunFinishedMessage('chat-1', 0), ctx);

		expect(setPendingPermissionRequests).toHaveBeenCalledWith(expect.any(Function));

		// Verify the filter function keeps plan-exit- prefixed entries.
		const filterFn = setPendingPermissionRequests.mock.calls[0][0] as (prev: Array<{ permissionRequestId: string }>) => Array<{ permissionRequestId: string }>;
		const result = filterFn([
			{ permissionRequestId: 'plan-exit-1' },
			{ permissionRequestId: 'tool-request-2' },
		]);
		expect(result).toHaveLength(1);
		expect(result[0].permissionRequestId).toBe('plan-exit-1');
	});
});

describe('handleAgentError', () => {
	it('clears loading and appends error message', () => {
		const ctx = createCtx();
		handleAgentError(new AgentRunFailedMessage('chat-1', 'Something broke'), ctx);

		expect(ctx.clearLoadingIndicators).toHaveBeenCalledWith('chat-1');
		expect(ctx.markChatsAsCompleted).toHaveBeenCalledWith('chat-1');
		expect(ctx.setChatMessages).toHaveBeenCalledWith(expect.any(Function));
		expect(ctx.setPendingPermissionRequests).toHaveBeenCalledWith([]);
	});
});
