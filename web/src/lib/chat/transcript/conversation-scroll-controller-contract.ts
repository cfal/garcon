import type { ActiveTranscriptState } from './active-transcript-state.svelte.js';
import type { ConversationViewportPort } from './conversation-viewport-port.js';

export type ConversationScrollState = Pick<
	ActiveTranscriptState,
	| 'canLoadEarlier'
	| 'displayMessageCount'
	| 'feedMutationClock'
	| 'hasEarlierRowsToReveal'
	| 'hasLaterMessages'
	| 'isLoadingMessages'
	| 'isUserScrolledUp'
	| 'invalidatePendingHistoryLoad'
	| 'invalidatePendingWindowNavigation'
	| 'loadEarlierPage'
	| 'loadLaterPage'
	| 'loadStatus'
	| 'navigateToWindow'
	| 'pageStates'
	| 'revealEarlierLoadedRows'
	| 'transcriptViewId'
	| 'windowRevision'
>;

export interface ConversationScrollControllerDeps {
	getScrollContainer: () => HTMLDivElement | null;
	getViewport: () => ConversationViewportPort | null;
	getQueueContainer: () => HTMLDivElement | undefined;
	chatState: ConversationScrollState;
	getChatId: () => string | null;
}
