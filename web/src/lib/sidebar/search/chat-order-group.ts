import type { PersistedChatOrderGroup } from '$shared/chat-order-contracts';

export function chatOrderGroupFor(chat: {
	isPinned: boolean;
	isArchived: boolean;
}): PersistedChatOrderGroup {
	if (chat.isPinned) return 'pinned';
	if (chat.isArchived) return 'archived';
	return 'normal';
}
