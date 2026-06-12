import {
	getSessionStorageItem,
	removeSessionStorageItem,
	SESSION_STORAGE_KEYS,
	setSessionStorageItem,
} from '$lib/utils/local-persistence';

export function getPendingChatId(): string | null {
	return getSessionStorageItem(SESSION_STORAGE_KEYS.pendingChatId);
}

export function setPendingChatId(chatId: string): void {
	setSessionStorageItem(SESSION_STORAGE_KEYS.pendingChatId, chatId);
}

export function clearPendingChatId(): void {
	removeSessionStorageItem(SESSION_STORAGE_KEYS.pendingChatId);
}
