import type { ConversationScrollState } from './conversation-scroll-controller-contract.js';
import type { ConversationViewportPort } from './conversation-viewport-port.js';
import type { TranscriptPageDirection, TranscriptPageLoadResult } from './transcript-page-progress.js';
import type { ConversationCompressedAutoFillBudget } from './conversation-compressed-autofill-budget.js';

interface ConversationViewportAutoFillOptions {
	chatId: string;
	transcriptViewId: string;
	viewport: ConversationViewportPort;
	chatState: ConversationScrollState;
	budget: ConversationCompressedAutoFillBudget;
	isCurrent: () => boolean;
	canRequestPage: (direction: TranscriptPageDirection) => boolean;
	mutatePage: (
		direction: TranscriptPageDirection,
		load: () => Promise<TranscriptPageLoadResult>,
	) => Promise<TranscriptPageLoadResult>;
	waitForCurrentLayout: () => Promise<TranscriptPageLoadResult>;
	isPinnedToBottom: () => boolean;
}

export async function fillConversationViewport(options: ConversationViewportAutoFillOptions): Promise<void> {
	const {
		chatId,
		transcriptViewId,
		viewport,
		chatState,
		budget,
		isCurrent,
		canRequestPage,
		mutatePage,
		waitForCurrentLayout,
		isPinnedToBottom,
	} = options;
	budget.startView(chatId, transcriptViewId);
	// Measured height, not the number of grouped rows, determines when paging stops.
	while (isCurrent()) {
		const layout = await viewport.waitForLayout({
			minimumDataRevision: chatState.feedMutationClock.dataRevision,
		});
		if (layout !== 'settled' || !isCurrent()) return;
		if ((await viewport.measureViewportFill()) !== 'underfilled') return;
		if (!isCurrent()) return;
		const compressed = viewport.hasCollapsedToolGroups();

		let result: TranscriptPageLoadResult;
		if (chatState.hasLaterMessages) {
			if (!canRequestPage('later') || !budget.admitRequest(compressed)) return;
			result = await mutatePage('later', () => chatState.loadLaterPage(chatId));
		} else if (chatState.canLoadEarlier) {
			if (!canRequestPage('earlier')) return;
			if (chatState.revealEarlierLoadedRows()) {
				result = await waitForCurrentLayout();
			} else {
				if (!budget.admitRequest(compressed)) return;
				result = await mutatePage('earlier', () => chatState.loadEarlierPage(chatId));
			}
		} else {
			return;
		}
		if (result !== 'loaded') return;
		if (isPinnedToBottom() && !chatState.hasLaterMessages) viewport.scrollToEnd();
	}
}
