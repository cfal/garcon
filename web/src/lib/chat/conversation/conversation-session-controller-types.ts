import type {
	ActiveTranscriptPort,
	ChatLoadMessagesOptions,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import type { AgentState } from '$lib/chat/conversation/agent-state.svelte.js';
import type { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { ConversationSessionsPort } from './conversation-sessions-port.js';
import type { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import type { SessionAgentId } from '$lib/types/app';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import type { ProjectTarget } from '$shared/project-resolution';
import type { ConversationExecutionSelection } from './conversation-execution-draft-state.svelte.js';

type SessionTranscriptState = Pick<
	ActiveTranscriptPort,
	| 'activeChatId'
	| 'entries'
	| 'chatMessages'
	| 'getCursor'
	| 'isUserScrolledUp'
	| 'activateChat'
	| 'appendLocalNotice'
	| 'clearOptimisticUserInput'
	| 'markOptimisticUserInputDelivered'
	| 'clearLocalNotices'
	| 'loadMessages'
	| 'upsertOptimisticUserInput'
	| 'excludedResendOrdinals'
	| 'clearResendExclusions'
> & {
	transcriptCache: Pick<ChatTranscriptCache, 'markValidated' | 'readAppliedCursor'>;
	hasMountedPresentation(chatId: string): boolean;
	getCursorForChat(chatId: string): ReturnType<ActiveTranscriptPort['getCursor']>;
	appendLocalNoticeForChat(
		chatId: string,
		noticeType: Parameters<ActiveTranscriptPort['appendLocalNotice']>[0],
		content: string,
	): void;
	clearLocalNoticesForChat(chatId: string, throughRevision?: number): void;
	noticeRevisionForChat(chatId: string): number;
};

export type SessionTranscriptLoadTarget = Pick<
	ActiveTranscriptPort,
	'activeChatId' | 'chatMessages' | 'getCursor' | 'activateChat' | 'loadMessages'
> & {
	transcriptCache: Pick<ChatTranscriptCache, 'markValidated' | 'readAppliedCursor'>;
};

export type PanelTranscriptSnapshotLoader = (options: ChatLoadMessagesOptions) => Promise<boolean>;

type SessionComposerState = Pick<
	ComposerState,
	| 'inputText'
	| 'images'
	| 'contentRevision'
	| 'isSubmitting'
	| 'clearAfterSubmit'
	| 'clearImages'
	| 'draftSnapshot'
	| 'draftRevision'
	| 'isDraftEmpty'
	| 'restoreDraftIfRevision'
	| 'restoreDraft'
	| 'saveDraft'
>;

type SessionAgentState = Pick<
	AgentState,
	| 'agentId'
	| 'executorId'
	| 'projectPath'
	| 'model'
	| 'apiProviderId'
	| 'modelEndpointId'
	| 'modelProtocol'
	| 'permissionMode'
	| 'thinkingMode'
	| 'agentSettings'
	| 'setAgentId'
	| 'setAgentSettings'
	| 'setModelSelection'
>;

type SessionLifecycleState = Pick<
	ConversationLifecycleState,
	| 'currentChatId'
	| 'loadingStatus'
	| 'beginTurn'
	| 'beginStopping'
	| 'clearTurnStatus'
	| 'restoreStopping'
	| 'applyProcessingPhase'
	| 'markTurnRunning'
	| 'setCurrentChatId'
	| 'setLoadingStatus'
>;

type SessionConversationUiState = Pick<
	ConversationUiPort,
	| 'pendingPermissionRequests'
	| 'previousPermissionMode'
	| 'activateTransientFeed'
	| 'getExecutionControl'
	| 'setExecutionControlFromLiveUpdate'
	| 'setExecutionControlFromRefresh'
	| 'isExecutionControlSocketInstanceConfirmed'
	| 'setPendingPermissionRequests'
	| 'setPreviousPermissionMode'
	| 'pendingPermissionsFor'
	| 'updatePendingPermissionsForChat'
	| 'beginPlanModeForChat'
	| 'previousPermissionModeFor'
	| 'finishPlanModeForChat'
	| 'setTransientFeedFromSnapshot'
>;

type SessionStartupCoordinator = Pick<StartupCoordinator, 'beginLocalStartup' | 'completeStartup'>;
export interface SessionControllerDeps {
	sessions: ConversationSessionsPort;
	chatState: SessionTranscriptState;
	composerState: SessionComposerState;
	agentState: SessionAgentState;
	lifecycle: SessionLifecycleState;
	lifecycleForChat(chatId: string): SessionLifecycleState;
	conversationUi: SessionConversationUiState;
	startupCoordinator: SessionStartupCoordinator;
	modelCatalog: Pick<
		ModelCatalogStore,
		| 'getModelForSelection'
		| 'isLocalModel'
		| 'selectionFor'
		| 'selectionValueFor'
		| 'getAgentLabel'
		| 'getDefaultAgentSettings'
		| 'getPermissionModes'
		| 'getThinkingModes'
		| 'supportsFork'
		| 'supportsForkWhileRunning'
		| 'supportsSteering'
	>;
	getExecutionDefaults(
		agentId: SessionAgentId,
		executorId?: string,
	): Pick<ConversationExecutionSelection, 'permissionMode' | 'thinkingMode' | 'agentSettings'>;
	modelCatalogForExecutor(executorId: string): SessionControllerDeps['modelCatalog'];
	canSubmitToExecutor(executorId: string): boolean;
	appShell: {
		openNewChatDialog: (opts: { prefill: string }) => void;
	};
	readReceiptOutbox: { enqueue: (chatId: string, readAt: string) => void };
	navigation: { navigateToChat?: (chatId: string) => void };
	requestProcessingSnapshot: (source: 'admission' | 'stop-probe') => Promise<unknown>;
	setIsViewportPinnedToBottom: (v: boolean) => void;
	setInitialBottomRestorePending: (chatId: string | null) => void;
	scrollToBottom: () => void;
	onProjectUnavailable?: (target: ProjectTarget) => Promise<void> | void;
}
