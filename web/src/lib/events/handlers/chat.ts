// Handles chat creation, stop acknowledgements, and WebSocket faults.

import type {
	ChatSessionCreatedMessage,
	ChatSessionStoppedMessage,
	WsFaultMessage,
} from '$shared/ws-events';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import type { ChatSessionRouterView } from '$lib/types/chat-session';
import type { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import { isAbortAcknowledged } from '$shared/chat-types';

export interface ChatEventContext {
	getSelectedChat: () => ChatSessionRouterView | null;
	getCurrentChatId: () => string | null;
	setCurrentChatId: (id: string | null) => void;
	appendLocalNotice: (noticeType: LocalNoticeType, content: string) => void;
	conversationUi: Pick<
		ConversationUiPort,
		| 'pendingViewChat'
		| 'setPendingViewChat'
		| 'setPendingPermissionRequests'
		| 'clearPendingPermissionRequests'
	>;
	isChatProcessing: (chatId?: string | null) => boolean;
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
	if (!isAbortAcknowledged(msg.outcome)) return;

	if (pendingChatId && (!abortedChatId || pendingChatId === abortedChatId)) {
		ctx.clearPendingChatId();
	}
	if (!ctx.isChatProcessing(abortedChatId)) {
		ctx.conversationUi.clearPendingPermissionRequests();
	}
	if (msg.intent === 'stop' && abortedChatId === ctx.getCurrentChatId()) {
		ctx.appendLocalNotice('warning', m.chat_notice_interrupted_by_user());
	}
}

export function handleWsError(msg: WsFaultMessage, ctx: ChatEventContext) {
	ctx.appendLocalNotice('error', msg.error || m.chat_notice_websocket_error());
}
