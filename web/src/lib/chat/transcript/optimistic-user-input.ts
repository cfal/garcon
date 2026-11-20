import type { ChatImage } from '$shared/chat-types';

export interface QueuedSteerReceipt {
	readonly clientMessageId: string;
	readonly serverInstanceId: string;
	readonly entryId: string;
	readonly transcriptViewId: string;
}

export interface QueuedSteerDelivery extends QueuedSteerReceipt {
	/** Null once the entry leaves the queue and the transcript must catch up. */
	readonly queuedAtVersion: number | null;
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
	readonly delivery: 'pending' | 'delivered' | QueuedSteerDelivery;
}
