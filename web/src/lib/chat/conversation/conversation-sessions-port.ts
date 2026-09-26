import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions-contract.js';

export type ConversationSessionsPort = Pick<
	ChatSessionsPort,
	| 'selectedChatId'
	| 'selectedChat'
	| 'byId'
	| 'startupByChatId'
	| 'isDraft'
	| 'patchDraftStartup'
	| 'patchChat'
	| 'patchLastReadAt'
	| 'applyStartEntry'
	| 'applyProcessingEvent'
	| 'processingPhase'
	| 'upsertServerChat'
	| 'reconcileAcceptedHandoffProjection'
	| 'quietRefreshChats'
	| 'observeCommandTagMutation'
	| 'setSelectedChatId'
	| 'renameChat'
	| 'moveChatToBoundary'
	| 'tagReconciliationKind'
	| 'applyChatTagDelta'
>;
