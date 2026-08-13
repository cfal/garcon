import type { TranscriptMessage } from '$shared/chat-view';
import type { ChatMessage, UserMessageDeliveryStatus } from '$shared/chat-types';
import type { PendingUserInput } from '$shared/pending-user-input';
import type { LocalNoticeType } from './local-notice.js';
import type { ChatTranscriptCache } from './chat-transcript-cache.svelte.js';
import type { ConversationFeedMutationClock } from './conversation-feed-mutations.js';

export interface ChatLoadMessagesOptions {
	minimumLimit?: number;
}

export interface ChatRestoreResult {
	count: number;
	stale: boolean;
}

export interface ChatCursor {
	transcriptViewId: string;
	lastOrdinal: number;
}

export interface ActiveTranscriptPort {
	readonly transcriptCache: ChatTranscriptCache;
	activeChatId: string | null;
	readonly entries: readonly TranscriptMessage[];
	readonly chatMessages: ChatMessage[];
	readonly feedMutationClock: ConversationFeedMutationClock;
	isUserScrolledUp: boolean;
	getCursor(): ChatCursor;
	applyMessages(
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		firstOrdinal: number,
		lastOrdinal: number,
	): 'applied' | 'view-changed' | 'gap-detected';
	loadMessages(chatId: string, options?: ChatLoadMessagesOptions): Promise<ChatMessage[]>;
	appendLocalNotice(noticeType: LocalNoticeType, content: string): void;
	appendServerNotice(chatId: string, noticeType: LocalNoticeType, content: string): void;
	discardServerNotices(chatId: string): void;
	clearLocalNotices(): void;
	setPendingUserInputs(inputs: PendingUserInput[]): void;
	upsertPendingUserInput(input: PendingUserInput): void;
	clearPendingUserInput(clientRequestId: string): void;
	updatePendingUserInputDeliveryStatus(
		clientRequestId: string,
		deliveryStatus: UserMessageDeliveryStatus,
	): void;
	activateChat(chatId: string | null): ChatRestoreResult | null;
}
