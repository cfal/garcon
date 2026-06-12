// Handles chat-session-created, chat-session-stopped, chat-processing-updated, and error events.

import type {
	ChatSessionCreatedMessage,
	ChatSessionStoppedMessage,
	ChatProcessingUpdatedMessage,
	WsFaultMessage,
} from '$shared/ws-events';
import { AssistantMessage, ErrorMessage } from '$shared/chat-types';
import type { ChatMessage } from '$lib/types/chat';
import type { SessionAgentId } from '$lib/types/app';
import type { ChatSessionRouterView } from '$lib/types/chat-session';
import type { StartupCoordinator } from '$lib/chat/startup-coordinator';
import type { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';

export interface ChatEventContext {
	getAgentId: () => SessionAgentId;
	getSelectedChat: () => ChatSessionRouterView | null;
	getCurrentChatId: () => string | null;
	setCurrentChatId: (id: string | null) => void;
	setChatMessages: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
	loadMessages: (chatId: string, loadMore?: boolean, agentId?: string) => Promise<ChatMessage[]>;
	setIsSystemChatChange: (v: boolean) => void;
	conversationUi: Pick<
		ConversationUiStore,
		| 'pendingViewChat'
		| 'setPendingViewChat'
		| 'setPendingPermissionRequests'
		| 'clearPendingPermissionRequests'
	>;
	activateLoadingFor: (chatId?: string | null) => void;
	clearLoadingIndicators: (chatId?: string | null) => void;
	markChatsAsCompleted: (...ids: Array<string | null | undefined>) => void;
	setCanAbort: (v: boolean) => void;
	onChatProcessing?: (chatId?: string | null) => void;
	onChatNotProcessing?: (chatId?: string | null) => void;
	// Startup ownership callbacks.
	startupCoordinator: StartupCoordinator;
	onLocalStartupConfirmed?: (chatId: string) => void;
	onExternalChatCreated?: (chatId: string) => void;
	getPendingChatId: () => string | null;
	setPendingChatId: (id: string) => void;
	clearPendingChatId: () => void;
}

export function handleChatCreated(msg: ChatSessionCreatedMessage, ctx: ChatEventContext) {
	const chatId = msg.chatId;
	if (!chatId) return;

	const coordinator = ctx.startupCoordinator;

	if (coordinator.matchesPendingStartup(chatId)) {
		// Local startup confirmation: this client initiated this chat.
		coordinator.completeStartup(chatId);

		ctx.setPendingChatId(chatId);
		const pendingViewChat = ctx.conversationUi.pendingViewChat;
		if (pendingViewChat && !pendingViewChat.chatId) {
			ctx.conversationUi.setPendingViewChat({ ...pendingViewChat, chatId });
		}

		ctx.setIsSystemChatChange(true);
		ctx.onLocalStartupConfirmed?.(chatId);

		ctx.conversationUi.setPendingPermissionRequests((previous) =>
			previous.map((request) => (request.chatId ? request : { ...request, chatId })),
		);
		return;
	}

	// External chat creation from another device/tab.
	ctx.onExternalChatCreated?.(chatId);
}

export function handleChatAborted(msg: ChatSessionStoppedMessage, ctx: ChatEventContext) {
	const pendingChatId = ctx.getPendingChatId();
	const abortedChatId = msg.chatId || ctx.getCurrentChatId();
	const abortSucceeded = msg.success !== false;

	if (abortSucceeded) {
		ctx.clearLoadingIndicators(abortedChatId);
		ctx.markChatsAsCompleted(abortedChatId);
		if (pendingChatId && (!abortedChatId || pendingChatId === abortedChatId)) {
			ctx.clearPendingChatId();
		}
		ctx.conversationUi.clearPendingPermissionRequests();
		ctx.setChatMessages((previous) => [
			...previous,
			new AssistantMessage(new Date().toISOString(), 'Chat interrupted by user.'),
		]);
	} else {
		ctx.setChatMessages((previous) => [
			...previous,
			new ErrorMessage(new Date().toISOString(), 'Stop request failed. The chat is still running.'),
		]);
	}
}

export function handleChatStatus(msg: ChatProcessingUpdatedMessage, ctx: ChatEventContext) {
	const statusChatId = msg.chatId;
	const currentChatId = ctx.getCurrentChatId();
	const selectedChat = ctx.getSelectedChat();
	const isCurrentChat =
		statusChatId === currentChatId || (selectedChat && statusChatId === selectedChat.id);

	if (statusChatId) {
		if (msg.isProcessing) {
			ctx.onChatProcessing?.(statusChatId);
		} else {
			ctx.onChatNotProcessing?.(statusChatId);
		}
	}

	if (!isCurrentChat) return;

	if (msg.isProcessing) {
		ctx.activateLoadingFor(statusChatId);
		ctx.setCanAbort(true);
	} else {
		ctx.clearLoadingIndicators(statusChatId);
		// The chat finished while disconnected -- agent-run-finished was lost so
		// the authoritative reload never happened. Reload now.
		const reloadId = statusChatId || selectedChat?.id;
		if (reloadId) {
			const chatProvider = selectedChat?.agentId || ctx.getAgentId();
			ctx
				.loadMessages(reloadId, false, chatProvider)
				.then((messages) => {
					// Guard: active chat may have changed while the reload was in flight.
					if (ctx.getCurrentChatId() !== reloadId) return;
					if (messages.length > 0) {
						ctx.setChatMessages(messages);
					}
				})
				.catch((err) => {
					// Transport failure; the reconnect effect in ConversationWorkspace retries.
					console.debug('[chat] reload failed for', reloadId, err);
				});
		}
	}
}

export function handleWsError(msg: WsFaultMessage, ctx: ChatEventContext) {
	ctx.setChatMessages((previous) => [
		...previous,
		new ErrorMessage(new Date().toISOString(), msg.error || 'WebSocket error'),
	]);
}
