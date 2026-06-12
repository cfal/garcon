export const PENDING_CHAT_ID_STORAGE_KEY = 'pendingChatId';

function getSessionStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.sessionStorage;
	} catch {
		return null;
	}
}

export function getPendingChatId(): string | null {
	try {
		return getSessionStorage()?.getItem(PENDING_CHAT_ID_STORAGE_KEY) ?? null;
	} catch {
		return null;
	}
}

export function setPendingChatId(chatId: string): void {
	try {
		getSessionStorage()?.setItem(PENDING_CHAT_ID_STORAGE_KEY, chatId);
	} catch {
		/* sessionStorage unavailable */
	}
}

export function clearPendingChatId(): void {
	try {
		getSessionStorage()?.removeItem(PENDING_CHAT_ID_STORAGE_KEY);
	} catch {
		/* sessionStorage unavailable */
	}
}
