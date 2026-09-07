import { ApiError } from '$lib/api/client.js';
import type { ChatTagsMutationResponse } from '$shared/chat-tag-mutations';
import { normalizeTags } from '$shared/tags';

export function sameChatTags(left: readonly string[], right: readonly string[]): boolean {
	const normalizedLeft = normalizeTags(left);
	const normalizedRight = normalizeTags(right);
	return normalizedLeft.length === normalizedRight.length
		&& normalizedLeft.every((tag, index) => tag === normalizedRight[index]);
}

export function createChatTagMutationResult(
	chatId: string,
	previousTags: readonly string[],
	tags: readonly string[],
): ChatTagsMutationResponse {
	const before = new Set(previousTags);
	const after = new Set(tags);
	return {
		success: true,
		chatId,
		tags: [...tags],
		addedTags: tags.filter((tag) => !before.has(tag)),
		removedTags: previousTags.filter((tag) => !after.has(tag)),
	};
}

export function isUnknownChatTagOutcome(error: unknown): boolean {
	return (
		error instanceof ApiError && error.errorCode === 'CHAT_TAG_SAVE_UNKNOWN'
	) || (
		error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')
	) || error instanceof TypeError;
}
