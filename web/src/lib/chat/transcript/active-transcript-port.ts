import type { ResendCandidate } from '$shared/chat-view';
import type { TranscriptMessage, TranscriptReadPurpose } from '$shared/chat-view';
import type { ChatMessage } from '$shared/chat-types';
import type { OptimisticUserInput } from './optimistic-user-input.js';
import type { LocalNoticeType } from './local-notice.js';
import type { ConversationFeedMutationClock } from './conversation-feed-mutations.js';
import type { ForkAtMessageSelection } from '$lib/chat/actions/fork-at-message-action.js';

export interface ChatLoadMessagesOptions {
	purpose?: TranscriptReadPurpose;
}

export interface ChatCursor {
	transcriptViewId: string;
	lastOrdinal: number;
}

export interface ActiveTranscriptPort {
	activeChatId: string | null;
	readonly entries: readonly TranscriptMessage[];
	readonly resendCandidates: readonly ResendCandidate[];
	readonly excludedResendOrdinals: readonly number[];
	readonly chatMessages: ChatMessage[];
	readonly feedMutationClock: ConversationFeedMutationClock;
	isUserScrolledUp: boolean;
	getCursor(): ChatCursor;
	forkSelection(ordinal: number): ForkAtMessageSelection | null;
	setResendCandidates(candidates: readonly ResendCandidate[]): void;
	excludeResendCandidate(ordinal: number): void;
	clearResendExclusions(): void;
	loadMessages(chatId: string, options?: ChatLoadMessagesOptions): Promise<ChatMessage[]>;
	appendLocalNotice(noticeType: LocalNoticeType, content: string): void;
	appendServerNotice(chatId: string, noticeType: LocalNoticeType, content: string): void;
	clearLocalNotices(): void;
	upsertOptimisticUserInput(input: OptimisticUserInput): void;
	markOptimisticUserInputDelivered(clientMessageId: string): void;
	clearOptimisticUserInput(clientMessageId: string): void;
	activateChat(chatId: string | null): void;
}
