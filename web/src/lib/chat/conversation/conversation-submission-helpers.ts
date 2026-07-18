import type { ChatImage } from '$shared/chat-types';
import type { PendingUserInput } from '$shared/pending-user-input';
import { mimeTypeForChatAttachment } from '$lib/chat/composer/image-attachment.svelte.js';

export function errorDetail(error: unknown): string {
	if (error instanceof Error) {
		const message = error.message.trim();
		if (message) return message;
		if (error.name && error.name !== 'Error') return error.name;
		return 'Unknown error';
	}
	const detail = String(error).trim();
	return detail || 'Unknown error';
}

export async function prepareChatImages(files: readonly File[]): Promise<ChatImage[]> {
	return Promise.all(files.map(fileToChatImage));
}

export function pendingUserInput(
	chatId: string,
	content: string,
	images: ChatImage[],
	clientRequestId: string,
	clientMessageId: string,
): PendingUserInput {
	return {
		chatId,
		clientRequestId,
		clientMessageId,
		content,
		createdAt: new Date().toISOString(),
		deliveryStatus: 'submitting',
		...(images.length > 0 ? { images } : {}),
	};
}

async function fileToChatImage(file: File): Promise<ChatImage> {
	const data = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === 'string') {
				resolve(reader.result);
			} else {
				reject(new Error('Failed to read attachment data URL'));
			}
		};
		reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment'));
		reader.onabort = () => reject(new Error('Attachment read aborted'));
		reader.readAsDataURL(file);
	});
	return { data, name: file.name, mimeType: mimeTypeForChatAttachment(file) };
}
