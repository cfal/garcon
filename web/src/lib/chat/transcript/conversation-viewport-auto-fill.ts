import { CHAT_MESSAGES_MAX_LIMIT } from '$shared/chat-view';
import type { ConversationScrollState } from './conversation-scroll-controller-contract.js';
import type { ConversationViewportPort } from './conversation-viewport-port.js';
import type { TranscriptPageDirection, TranscriptPageLoadResult } from './transcript-page-progress.js';
import type { ConversationCompressedAutoFillBudget } from './conversation-compressed-autofill-budget.js';

const COMPRESSED_AUTO_FILL_VISIBLE_LIMIT = Math.min(200, CHAT_MESSAGES_MAX_LIMIT);

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

function loadAutoFillPage(
	chatState: ConversationScrollState,
	direction: TranscriptPageDirection,
	chatId: string,
	compressed: boolean,
): Promise<TranscriptPageLoadResult> {
	if (direction === 'earlier') {
		if (compressed) {
			return chatState.loadEarlierPage(chatId, {
				visibleLimit: COMPRESSED_AUTO_FILL_VISIBLE_LIMIT,
			});
		}
		return chatState.loadEarlierPage(chatId);
	}
	if (compressed) {
		return chatState.loadLaterPage(chatId, {
			visibleLimit: COMPRESSED_AUTO_FILL_VISIBLE_LIMIT,
		});
	}
	return chatState.loadLaterPage(chatId);
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
			if (!canRequestPage('later') || !budget.admitDemand(compressed)) return;
			result = await mutatePage('later', () =>
				loadAutoFillPage(chatState, 'later', chatId, compressed),
			);
		} else if (chatState.canLoadEarlier) {
			if (!canRequestPage('earlier')) return;
			if (chatState.revealEarlierLoadedRows()) {
				result = await waitForCurrentLayout();
			} else {
				if (!budget.admitDemand(compressed)) return;
				result = await mutatePage('earlier', () =>
					loadAutoFillPage(chatState, 'earlier', chatId, compressed),
				);
			}
		} else {
			return;
		}
		if (result !== 'loaded') return;
		if (isPinnedToBottom() && !chatState.hasLaterMessages) viewport.scrollToEnd();
	}
}
