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
	| 'observeCommandTagMutation'
	| 'setSelectedChatId'
	| 'renameChat'
	| 'moveChatToBoundary'
	| 'applyChatTagDelta'
>;
