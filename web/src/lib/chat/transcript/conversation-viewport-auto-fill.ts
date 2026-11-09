import type { ConversationScrollState } from './conversation-scroll-controller-contract.js';
import type { ConversationViewportPort } from './conversation-viewport-port.js';
import type { TranscriptPageDirection, TranscriptPageLoadResult } from './transcript-page-progress.js';

interface ConversationViewportAutoFillOptions {
	chatId: string;
	viewport: ConversationViewportPort;
	chatState: ConversationScrollState;
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
		viewport,
		chatState,
		isCurrent,
		canRequestPage,
		mutatePage,
		waitForCurrentLayout,
		isPinnedToBottom,
	} = options;
	while (isCurrent()) {
		const layout = await viewport.waitForLayout({
			minimumDataRevision: chatState.feedMutationClock.dataRevision,
		});
		if (layout !== 'settled' || !isCurrent()) return;
		if ((await viewport.measureViewportFill()) !== 'underfilled') return;
		if (!isCurrent()) return;

		let result: TranscriptPageLoadResult;
		if (chatState.hasLaterMessages) {
			if (!canRequestPage('later')) return;
			result = await mutatePage('later', () =>
				chatState.loadLaterPage(chatId),
			);
		} else if (chatState.canLoadEarlier) {
			if (!canRequestPage('earlier')) return;
			if (chatState.revealEarlierLoadedRows()) {
				result = await waitForCurrentLayout();
			} else {
				result = await mutatePage('earlier', () =>
					chatState.loadEarlierPage(chatId),
				);
			}
		} else {
			return;
		}
		if (result !== 'loaded' || !isCurrent()) return;
		if (isPinnedToBottom() && !chatState.hasLaterMessages) viewport.scrollToEnd();
	}
}
