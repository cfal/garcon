import type {
	applyChatTagDelta,
	deleteChat,
	generateChatTitle,
	recoverChatTags,
	reorderChat,
	replaceChatTags,
	setLastSelectedChat,
	transitionChatTags,
	toggleArchive,
} from '$lib/api/chats.js';
import type { updateSessionName } from '$lib/api/settings.js';
import type { ChatSessionRecord, ChatStartupConfig } from '$lib/types/chat-session';
import type { ChatListEntry } from '$shared/chat-list';
import type { ChatOrderBoundary, ReorderChatResponse } from '$shared/chat-order-contracts';
import type {
	ChatProcessingEntry,
	ChatProcessingPhase,
} from '$shared/chat-types';
import type {
	ApplyChatTagDeltaRequest,
	ChatTagsMutationResponse,
	CommandTagMutationOutcome,
	RecoverChatTagsResponse,
	ReplaceChatTagsRequest,
	TransitionChatTagsRequest,
} from '$shared/chat-tag-mutations';

export interface ChatSessionsStoreDeps {
	listChats?: typeof import('$lib/api/chats.js').listChats;
	deleteChat?: typeof deleteChat;
	setLastSelectedChat?: typeof setLastSelectedChat;
	generateChatTitle?: typeof generateChatTitle;
	updateSessionName?: typeof updateSessionName;
	reorderChat?: typeof reorderChat;
	replaceChatTags?: typeof replaceChatTags;
	applyChatTagDelta?: typeof applyChatTagDelta;
	transitionChatTags?: typeof transitionChatTags;
	recoverChatTags?: typeof recoverChatTags;
	toggleArchive?: typeof toggleArchive;
	notifyError?: (message: string) => void;
}

export interface ChatArchiveMutation {
	chatIds: string[];
	completion: Promise<void>;
}

export interface ChatProcessingTransition {
	chatId: string;
	previousPhase: ChatProcessingPhase | null;
	phase: ChatProcessingPhase | null;
}

export type ChatListLoadStatus = 'loading' | 'ready' | 'error';

export interface ChatSessionsPort {
	byId: Record<string, ChatSessionRecord>;
	order: string[];
	readonly chatListStatus: ChatListLoadStatus;
	readonly chatListError: string | null;
	selectedChatId: string | null;
	startupByChatId: Record<string, ChatStartupConfig>;
	readonly selectedChat: ChatSessionRecord | null;
	setSelectedChatId(chatId: string | null): void;
	quietRefreshChats(): Promise<void>;
	renameChat(chatId: string, newTitle: string): Promise<boolean>;
	moveChatToBoundary(
		chatId: string,
		boundary: ChatOrderBoundary,
	): Promise<ReorderChatResponse | null>;
	readonly orderedChats: ChatSessionRecord[];
	readonly pendingTagMutationChatIds: ReadonlySet<string>;
	readonly tagRecoveryRequiredChatIds: ReadonlySet<string>;
	replaceChatTags(request: ReplaceChatTagsRequest): Promise<ChatTagsMutationResponse>;
	applyChatTagDelta(request: ApplyChatTagDeltaRequest): Promise<ChatTagsMutationResponse>;
	transitionChatTags(request: TransitionChatTagsRequest): Promise<ChatTagsMutationResponse>;
	recoverChatTags(chatId: string): Promise<RecoverChatTagsResponse>;
	observeCommandTagMutation(chatId: string, outcome: CommandTagMutationOutcome): Promise<void>;
	reconcileAcceptedHandoffProjection(entry: ChatListEntry): void;
	hasChat(chatId: string): boolean;
	isDraft(chatId: string): boolean;
	patchDraftStartup(chatId: string, patch: Partial<ChatStartupConfig>): void;
	applyStartEntry(entry: ChatListEntry): void;
	upsertServerChat(entry: ChatListEntry): void;
	removeChat(chatId: string): void;
	patchPreview(chatId: string, content: string, timestamp?: string): void;
	patchActivity(chatId: string, timestamp: string): void;
	patchChat(chatId: string, patch: Partial<ChatSessionRecord>): void;
	projectPathRevision(chatId: string): number;
	onProjectPathChanged(listener: (chatId: string, projectPath: string | null) => void): () => void;
	patchLastReadAt(chatId: string, lastReadAt: string): void;
	isChatProcessing(chatId: string): boolean;
	processingPhase(chatId: string): ChatProcessingPhase | null;
	applyProcessingEvent(chatId: string, phase: ChatProcessingPhase | null): ChatProcessingTransition;
	reconcileProcessing(entries: readonly ChatProcessingEntry[]): ChatProcessingTransition[];
}
