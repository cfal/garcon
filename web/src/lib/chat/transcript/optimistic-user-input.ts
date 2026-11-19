import type { ChatImage } from '$shared/chat-types';

export interface QueuedSteerReceipt {
	readonly clientMessageId: string;
	readonly serverInstanceId: string;
	readonly entryId: string;
}

export type InputStatus = 'sending' | 'waiting-to-steer';

export interface OptimisticUserInput {
	readonly chatId: string;
	readonly clientMessageId: string;
	readonly content: string;
	readonly contentMode?: 'literal';
	readonly contentFormat?: 'plain' | 'markdown';
	readonly createdAt: string;
	readonly images?: ChatImage[];
	readonly delivery: 'pending' | 'delivered' | QueuedSteerReceipt;
}
