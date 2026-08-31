import type { ActiveTranscriptState } from './active-transcript-state.svelte.js';
import type { ConversationViewportPort } from './conversation-viewport-port.js';

export type ConversationScrollState = Pick<
	ActiveTranscriptState,
	| 'canLoadEarlier'
	| 'displayMessageCount'
	| 'feedMutationClock'
	| 'transcriptViewId'
	| 'hasLaterMessages'
	| 'hasEarlierRowsToReveal'
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
	| 'windowRevision'
>;

export interface ScrollControllerDeps {
	getScrollContainer: () => HTMLDivElement | null;
	getViewport: () => ConversationViewportPort | null;
	getQueueContainer: () => HTMLDivElement | undefined;
	chatState: ConversationScrollState;
	getChatId: () => string | null;
}
