import type { ChatImage } from '$shared/chat-types';

export interface OptimisticUserInput {
	readonly chatId: string;
	readonly clientMessageId: string;
	readonly content: string;
	readonly createdAt: string;
	readonly images?: ChatImage[];
	// Whether the submitting request has come back. A row stays pending while the HTTP call is
	// in flight, which is the only window where the user cannot tell delivery from lost
	// connectivity.
	readonly delivery: 'pending' | 'delivered';
}
