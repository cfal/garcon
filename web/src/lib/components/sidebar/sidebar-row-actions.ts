import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import type { WorkspaceWindowEdge } from '$lib/workspace/surface-types.js';

export interface SidebarRowActions {
	onEnterMultiSelect?: (chatId: string) => void;
	onMultiSelectToggle?: (chatId: string, shiftKey: boolean) => void;
	onChatSelect: (chatId: string) => void;
	onDeleteChat: (chat: ChatSessionRecord) => void;
	onStartRenameChat: (chat: ChatSessionRecord) => void;
	onTogglePinned: (chatId: string) => void;
	onToggleArchive: (chatId: string) => void;
	isArchiveMutationPending?: (chatId: string) => boolean;
	onShowDetails: (chat: ChatSessionRecord) => void;
	onForkChat: (sourceChatId: string) => void;
	onShareChat: (chat: ChatSessionRecord) => void;
	onTagClick?: (tag: string) => void;
	onManageTags?: (chat: ChatSessionRecord) => void;
	onOpenInNewWindow?: (chatId: string, edge?: WorkspaceWindowEdge) => void;
}
