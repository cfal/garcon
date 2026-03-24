import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleChatCreated } from '../handlers/chat';
import { StartupCoordinator } from '$lib/chat/startup-coordinator';
import type { ChatEventContext } from '../handlers/chat';
import { ChatSessionCreatedMessage } from '$shared/ws-events';

function makeCtx(overrides: Partial<ChatEventContext> = {}): ChatEventContext {
	return {
		provider: 'claude',
		projectPath: '/project',
		selectedChat: null,
		getCurrentChatId: () => null,
		setCurrentChatId: vi.fn(),
		setChatMessages: vi.fn(),
		loadMessages: vi.fn().mockResolvedValue([]),
		setIsSystemChatChange: vi.fn(),
		setPendingPermissionRequests: vi.fn(),
		pendingViewChat: null,
		setPendingViewChat: vi.fn(),
		activateLoadingFor: vi.fn(),
		clearLoadingIndicators: vi.fn(),
		markChatsAsCompleted: vi.fn(),
		setCanAbort: vi.fn(),
		startupCoordinator: new StartupCoordinator(),
		onLocalStartupConfirmed: vi.fn(),
		onExternalChatCreated: vi.fn(),
		getPendingChatId: vi.fn().mockReturnValue(null),
		setPendingChatId: vi.fn(),
		clearPendingChatId: vi.fn(),
		...overrides,
	};
}

function makeMsg(chatId: string): ChatSessionCreatedMessage {
	return new ChatSessionCreatedMessage(chatId);
}

describe('handleChatCreated', () => {
	let coordinator: StartupCoordinator;

	beforeEach(() => {
		coordinator = new StartupCoordinator();
	});

	it('does nothing when chatId is empty', () => {
		const ctx = makeCtx({ startupCoordinator: coordinator });
		handleChatCreated(new ChatSessionCreatedMessage(''), ctx);

		expect(ctx.onLocalStartupConfirmed).not.toHaveBeenCalled();
		expect(ctx.onExternalChatCreated).not.toHaveBeenCalled();
	});

	it('confirms local startup when coordinator matches', () => {
		coordinator.beginLocalStartup('chat-1');
		const ctx = makeCtx({ startupCoordinator: coordinator });

		handleChatCreated(makeMsg('chat-1'), ctx);

		expect(ctx.onLocalStartupConfirmed).toHaveBeenCalledWith('chat-1');
		expect(ctx.onExternalChatCreated).not.toHaveBeenCalled();
		expect(ctx.setIsSystemChatChange).toHaveBeenCalledWith(true);
		expect(coordinator.currentPending).toBeNull();
	});

	it('calls onExternalChatCreated for non-local chats', () => {
		const ctx = makeCtx({ startupCoordinator: coordinator });

		handleChatCreated(makeMsg('remote-chat'), ctx);

		expect(ctx.onExternalChatCreated).toHaveBeenCalledWith('remote-chat');
		expect(ctx.onLocalStartupConfirmed).not.toHaveBeenCalled();
		expect(ctx.setIsSystemChatChange).not.toHaveBeenCalled();
	});

	it('calls onExternalChatCreated when coordinator has different pending', () => {
		coordinator.beginLocalStartup('chat-1');
		const ctx = makeCtx({ startupCoordinator: coordinator });

		handleChatCreated(makeMsg('chat-2'), ctx);

		expect(ctx.onExternalChatCreated).toHaveBeenCalledWith('chat-2');
		expect(ctx.onLocalStartupConfirmed).not.toHaveBeenCalled();
		// Local pending should still be alive for chat-1.
		expect(coordinator.matchesPendingStartup('chat-1')).toBe(true);
	});

	it('updates pending permission requests with chatId on local startup', () => {
		coordinator.beginLocalStartup('chat-1');
		const setPending = vi.fn();
		const ctx = makeCtx({
			startupCoordinator: coordinator,
			setPendingPermissionRequests: setPending,
		});

		handleChatCreated(makeMsg('chat-1'), ctx);

		expect(setPending).toHaveBeenCalledTimes(1);
		const updater = setPending.mock.calls[0][0];
		expect(typeof updater).toBe('function');

		const result = updater([
			{ permissionRequestId: 'r1', requestedTool: { type: 'bash-tool-use', toolId: 't1' }, chatId: '' },
			{ permissionRequestId: 'r2', requestedTool: { type: 'read-tool-use', toolId: 't2' }, chatId: 'existing' },
		]);
		expect(result[0].chatId).toBe('chat-1');
		expect(result[1].chatId).toBe('existing');
	});

	it('updates pendingViewChat on local startup when chatId is missing', () => {
		coordinator.beginLocalStartup('chat-1');
		const setPendingViewChat = vi.fn();
		const ctx = makeCtx({
			startupCoordinator: coordinator,
			pendingViewChat: { chatId: '' } as never,
			setPendingViewChat,
		});

		handleChatCreated(makeMsg('chat-1'), ctx);

		expect(setPendingViewChat).toHaveBeenCalledWith({ chatId: 'chat-1' });
	});

	it('does not update pendingViewChat when it already has a chatId', () => {
		coordinator.beginLocalStartup('chat-1');
		const setPendingViewChat = vi.fn();
		const ctx = makeCtx({
			startupCoordinator: coordinator,
			pendingViewChat: { chatId: 'existing' } as never,
			setPendingViewChat,
		});

		handleChatCreated(makeMsg('chat-1'), ctx);

		expect(setPendingViewChat).not.toHaveBeenCalled();
	});

	it('no longer guards on currentChatId being set', () => {
		// Previously the handler would skip when currentChatId was set.
		// With the coordinator pattern, local startup is only matched when
		// the coordinator has a pending entry, so currentChatId is irrelevant.
		coordinator.beginLocalStartup('chat-1');
		const ctx = makeCtx({
			startupCoordinator: coordinator,
			getCurrentChatId: () => 'other-chat',
		});

		handleChatCreated(makeMsg('chat-1'), ctx);

		expect(ctx.onLocalStartupConfirmed).toHaveBeenCalledWith('chat-1');
	});
});
