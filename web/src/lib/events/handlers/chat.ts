// Handles chat-session-created, chat-session-stopped, chat-processing-updated, and error events.

import type {
	ChatSessionCreatedMessage,
	ChatSessionStoppedMessage,
	ChatProcessingUpdatedMessage,
	WsFaultMessage,
} from '$shared/ws-events';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import type { ChatSessionRouterView } from '$lib/types/chat-session';
import type { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import type { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import * as m from '$lib/paraglide/messages.js';

export interface ChatEventContext {
	getSelectedChat: () => ChatSessionRouterView | null;
	getCurrentChatId: () => string | null;
	setCurrentChatId: (id: string | null) => void;
	appendLocalNotice: (noticeType: LocalNoticeType, content: string) => void;
	conversationUi: Pick<
		ConversationUiState,
		| 'pendingViewChat'
		| 'setPendingViewChat'
		| 'setPendingPermissionRequests'
		| 'clearPendingPermissionRequests'
	>;
	markTurnRunning: (chatId?: string | null) => void;
	clearTurnStatus: (chatId?: string | null) => void;
	markChatsAsCompleted: (...ids: Array<string | null | undefined>) => void;
	onChatProcessing: (chatId?: string | null) => void;
	onChatNotProcessing: (chatId?: string | null) => void;
	// Startup ownership callbacks.
	startupCoordinator: StartupCoordinator;
	onExternalChatCreated: (chatId: string) => void;
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

		ctx.conversationUi.setPendingPermissionRequests((previous) =>
			previous.map((request) => (request.chatId ? request : { ...request, chatId })),
		);
		return;
	}

	// External chat creation from another device/tab.
	ctx.onExternalChatCreated(chatId);
}

export function handleChatAborted(msg: ChatSessionStoppedMessage, ctx: ChatEventContext) {
	const pendingChatId = ctx.getPendingChatId();
	const abortedChatId = msg.chatId || ctx.getCurrentChatId();
	const abortSucceeded = msg.success !== false;

	if (abortSucceeded) {
		ctx.clearTurnStatus(abortedChatId);
		ctx.markChatsAsCompleted(abortedChatId);
		if (pendingChatId && (!abortedChatId || pendingChatId === abortedChatId)) {
			ctx.clearPendingChatId();
		}
		ctx.conversationUi.clearPendingPermissionRequests();
		if (msg.intent === 'stop') {
			ctx.appendLocalNotice('warning', m.chat_notice_interrupted_by_user());
		}
	} else {
		ctx.appendLocalNotice('error', m.chat_notice_stop_request_failed());
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
			ctx.onChatProcessing(statusChatId);
		} else {
			ctx.onChatNotProcessing(statusChatId);
		}
	}

	if (!isCurrentChat) return;

	if (msg.isProcessing) {
		ctx.markTurnRunning(statusChatId);
	} else {
		ctx.clearTurnStatus(statusChatId);
	}
}

export function handleWsError(msg: WsFaultMessage, ctx: ChatEventContext) {
	ctx.appendLocalNotice('error', msg.error || m.chat_notice_websocket_error());
}
