import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import type { ChatMessage } from '$shared/chat-types';
import type { OptimisticUserInput } from './optimistic-user-input.js';
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
	readonly resendCandidates: readonly ResendCandidate[];
	readonly excludedResendOrdinals: readonly number[];
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
		resendCandidates?: ResendCandidate[],
	): 'applied' | 'view-changed' | 'gap-detected';
	setResendCandidates(candidates: readonly ResendCandidate[]): void;
	excludeResendCandidate(ordinal: number): void;
	clearResendExclusions(): void;
	loadMessages(chatId: string, options?: ChatLoadMessagesOptions): Promise<ChatMessage[]>;
	appendLocalNotice(noticeType: LocalNoticeType, content: string): void;
	appendServerNotice(chatId: string, noticeType: LocalNoticeType, content: string): void;
	discardServerNotices(chatId: string): void;
	clearLocalNotices(): void;
	upsertOptimisticUserInput(input: OptimisticUserInput): void;
	clearOptimisticUserInput(clientMessageId: string): void;
	activateChat(chatId: string | null): ChatRestoreResult | null;
}
