import type { ChatImage } from '$shared/chat-types';

export interface OptimisticUserInput {
	readonly chatId: string;
	readonly clientMessageId: string;
	readonly content: string;
	readonly createdAt: string;
	readonly images?: ChatImage[];
}
