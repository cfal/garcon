import type { ChatImage } from '$shared/chat-types';

export interface QueuedSteerReceipt {
	readonly clientMessageId: string;
	readonly serverInstanceId: string;
	readonly entryId: string;
	readonly transcriptViewId: string;
}

export interface QueuedSteerDelivery extends QueuedSteerReceipt {
	readonly kind: 'queued';
	/** Null once the entry leaves the queue and the transcript must catch up. */
	readonly queuedAtVersion: number | null;
}

export interface DeliveredSteerReceipt {
	readonly kind: 'delivered';
	readonly clientMessageId: string;
	readonly transcriptViewId: string;
}

export type SteerDelivery = QueuedSteerDelivery | DeliveredSteerReceipt;

export type InputStatus = 'sending' | 'waiting-to-steer';

export interface OptimisticUserInput {
	readonly chatId: string;
	readonly clientMessageId: string;
	readonly content: string;
	readonly contentMode?: 'literal';
	readonly contentFormat?: 'plain' | 'markdown';
	readonly createdAt: string;
	readonly images?: ChatImage[];
	readonly placement?: 'live-tail';
	readonly delivery: 'pending' | 'delivered' | SteerDelivery;
}
