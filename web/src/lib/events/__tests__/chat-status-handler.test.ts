import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleChatStatus } from '../handlers/chat';
import { StartupCoordinator } from '$lib/chat/startup-coordinator';
import type { ChatEventContext } from '../handlers/chat';
import { ChatProcessingUpdatedMessage } from '$shared/ws-events';

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

		expect(ctx.loadMessages).not.toHaveBeenCalled();
		expect(ctx.activateLoadingFor).not.toHaveBeenCalled();
	});

	it('activates loading for the current chat when processing', () => {
		const ctx = makeCtx({ getCurrentChatId: () => 'chat-a' });
		handleChatStatus(makeMsg('chat-a', true), ctx);

		expect(ctx.activateLoadingFor).toHaveBeenCalledWith('chat-a');
		expect(ctx.setCanAbort).toHaveBeenCalledWith(true);
	});

	it('clears loading and reloads messages when processing stops', () => {
		const ctx = makeCtx({ getCurrentChatId: () => 'chat-a' });
		handleChatStatus(makeMsg('chat-a', false), ctx);

		expect(ctx.clearLoadingIndicators).toHaveBeenCalledWith('chat-a');
		expect(ctx.loadMessages).toHaveBeenCalledWith('chat-a', false, 'claude');
	});

	it('fires onChatProcessing/onChatNotProcessing callbacks', () => {
		const ctx = makeCtx({ getCurrentChatId: () => 'chat-a' });

		handleChatStatus(makeMsg('chat-a', true), ctx);
		expect(ctx.onChatProcessing).toHaveBeenCalledWith('chat-a');

		handleChatStatus(makeMsg('chat-a', false), ctx);
		expect(ctx.onChatNotProcessing).toHaveBeenCalledWith('chat-a');
	});

	it('does NOT apply reloaded messages if the active chat changed during the reload', async () => {
		// Simulate: start reload for chat-a, then switch to chat-b before resolve.
		let activeChatId: string | null = 'chat-a';
		let resolveReload!: (msgs: unknown[]) => void;
		const loadPromise = new Promise<unknown[]>((resolve) => { resolveReload = resolve; });

		const ctx = makeCtx({
			getCurrentChatId: () => activeChatId,
			loadMessages: vi.fn().mockReturnValue(loadPromise),
		});

		handleChatStatus(makeMsg('chat-a', false), ctx);
		expect(ctx.loadMessages).toHaveBeenCalledWith('chat-a', false, 'claude');

		// User switches to a different chat while the reload is in flight.
		activeChatId = 'chat-b';

		// Resolve the stale reload.
		resolveReload([{ id: 'msg-1' }]);
		await loadPromise;

		// Allow microtask queue to flush .then() handlers.
		await new Promise((r) => setTimeout(r, 0));

		// setChatMessages must NOT have been called -- the guard prevents stale writes.
		expect(ctx.setChatMessages).not.toHaveBeenCalled();
	});

	it('applies reloaded messages when the active chat is still the same', async () => {
		let resolveReload!: (msgs: unknown[]) => void;
		const loadPromise = new Promise<unknown[]>((resolve) => { resolveReload = resolve; });

		const ctx = makeCtx({
			getCurrentChatId: () => 'chat-a',
			loadMessages: vi.fn().mockReturnValue(loadPromise),
		});

		handleChatStatus(makeMsg('chat-a', false), ctx);

		// Chat stays as chat-a.
		resolveReload([{ id: 'msg-1' }]);
		await loadPromise;
		await new Promise((r) => setTimeout(r, 0));

		expect(ctx.setChatMessages).toHaveBeenCalledWith([{ id: 'msg-1' }]);
	});
});
