// Handles sidebar-related WebSocket events: chat-title-updated, chat-session-deleted,
// chat-read-updated-v1, and chat-list-refresh-requested. These events drive
// sidebar state so the UI stays in sync with server-side mutations
// without polling.

import type {
	ChatTitleUpdatedMessage,
	ChatSessionDeletedWsMessage,
	ChatReadUpdatedV1Message,
	ChatListRefreshRequestedMessage,
	ChatProjectPathUpdatedMessage,
} from '$shared/ws-events';
import type { ProjectResolution, ProjectTarget } from '$shared/project-resolution';

export interface SidebarContext {
	removeChat: (chatId: string) => void;
	navigateAwayFromChat: (chatId: string) => void;
	patchChatTitle: (chatId: string, title: string) => void;
	patchChatProjectPath: (
		chatId: string,
		patch: { projectPath: string },
	) => void;
	invalidateProjectResolution: (chatId: string) => void;
	seedProjectResolution: (target: ProjectTarget, resolution: ProjectResolution) => void;
	patchLastReadAt: (chatId: string, lastReadAt: string) => void;
	refreshChats: () => void;
	removeChatTranscript: (chatId: string) => void;
	clearChatPresentations: (chatId: string) => void;
}

export function handleChatTitle(msg: ChatTitleUpdatedMessage, ctx: SidebarContext) {
	if (!msg.chatId || !msg.title) return;
	ctx.patchChatTitle(msg.chatId, msg.title);
}

export function handleChatDeleted(msg: ChatSessionDeletedWsMessage, ctx: SidebarContext) {
	if (!msg.chatId) return;
	ctx.navigateAwayFromChat(msg.chatId);
	ctx.removeChat(msg.chatId);
	ctx.clearChatPresentations(msg.chatId);
	ctx.removeChatTranscript(msg.chatId);
}

export function handleChatReadUpdated(msg: ChatReadUpdatedV1Message, ctx: SidebarContext) {
	if (!msg.chatId || !msg.lastReadAt) return;
	ctx.patchLastReadAt(msg.chatId, msg.lastReadAt);
}

export function handleChatProjectPathUpdated(
	msg: ChatProjectPathUpdatedMessage,
	ctx: SidebarContext,
) {
	if (!msg.chatId || !msg.projectPath || !msg.effectiveProjectKey) return;
	ctx.invalidateProjectResolution(msg.chatId);
	ctx.patchChatProjectPath(msg.chatId, {
		projectPath: msg.projectPath,
	});
	ctx.seedProjectResolution(
		{ kind: 'chat', chatId: msg.chatId, projectPath: msg.projectPath },
		{ kind: 'available', effectiveProjectKey: msg.effectiveProjectKey },
	);
}

export function handleChatListInvalidated(
	msg: ChatListRefreshRequestedMessage,
	ctx: SidebarContext,
) {
	if (!msg.chatId) return;
	ctx.refreshChats();
}
