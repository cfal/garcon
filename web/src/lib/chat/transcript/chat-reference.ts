import { CHAT_ID_LENGTH, parseChatId, type ChatId } from '$shared/chat-id.js';

export interface ChatReferenceResolution {
	readonly title: string | null;
	readonly isCurrent: boolean;
}

export interface ChatReferenceTarget {
	readonly title?: string | null;
}

export type ResolveChatReference = (chatId: string) => ChatReferenceResolution | null;

const CHAT_REFERENCE_HREF = new RegExp(`^/chat/(\\d{${CHAT_ID_LENGTH}})$`);

export function parseChatReferenceHref(rawHref: string | null | undefined): ChatId | null {
	if (!rawHref) return null;
	const match = CHAT_REFERENCE_HREF.exec(rawHref);
	if (!match) return null;
	try {
		return parseChatId(match[1]);
	} catch {
		return null;
	}
}

export function resolveChatReferenceTarget(
	chatId: string,
	currentChatId: string | null | undefined,
	target: ChatReferenceTarget | null | undefined,
): ChatReferenceResolution | null {
	if (!target) return null;
	const title = target.title?.trim();
	return {
		title: title && title !== chatId ? title : null,
		isCurrent: currentChatId === chatId,
	};
}
