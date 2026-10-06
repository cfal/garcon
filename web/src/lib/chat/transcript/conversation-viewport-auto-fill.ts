import { CHAT_MESSAGES_MAX_LIMIT } from '$shared/chat-view';
import type { ConversationScrollState } from './conversation-scroll-controller-contract.js';
import type { ConversationViewportPort } from './conversation-viewport-port.js';
import type { TranscriptPageDirection, TranscriptPageLoadResult } from './transcript-page-progress.js';
import type { ConversationAutoFillBudget } from './conversation-auto-fill-budget.js';
import type { TranscriptReadBudget } from './transcript-read-budget.js';

const COMPRESSED_AUTO_FILL_VISIBLE_LIMIT = Math.min(200, CHAT_MESSAGES_MAX_LIMIT);

interface ConversationViewportAutoFillOptions {
	chatId: string;
	transcriptViewId: string;
	viewport: ConversationViewportPort;
	chatState: ConversationScrollState;
	budget: ConversationAutoFillBudget;
	isCurrent: () => boolean;
	canRequestPage: (direction: TranscriptPageDirection) => boolean;
	mutatePage: (
		direction: TranscriptPageDirection,
		load: () => Promise<TranscriptPageLoadResult>,
	) => Promise<TranscriptPageLoadResult>;
	isPinnedToBottom: () => boolean;
}

function loadAutoFillPage(
	chatState: ConversationScrollState,
	direction: TranscriptPageDirection,
	chatId: string,
	compressed: boolean,
	budget: TranscriptReadBudget,
): Promise<TranscriptPageLoadResult> {
	const options = {
		budget,
		...(compressed ? { visibleLimit: COMPRESSED_AUTO_FILL_VISIBLE_LIMIT } : {}),
	};
	if (direction === 'earlier') {
		return chatState.loadEarlierPage(chatId, options);
	}
	return chatState.loadLaterPage(chatId, options);
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
			if (!canRequestPage('later')) return;
			if (!budget.admitDemand()) {
				chatState.pageStates.later = { status: 'bounded', error: null };
				return;
			}
			result = await mutatePage('later', () =>
				loadAutoFillPage(chatState, 'later', chatId, compressed, budget.reads),
			);
		} else if (chatState.canLoadEarlier) {
			if (!canRequestPage('earlier')) return;
			if (!budget.admitDemand()) {
				chatState.pageStates.earlier = { status: 'bounded', error: null };
				return;
			}
			result = await mutatePage('earlier', () =>
				loadAutoFillPage(chatState, 'earlier', chatId, compressed, budget.reads),
			);
		} else {
			return;
		}
		if (result !== 'loaded' && result !== 'bounded') return;
		if (isPinnedToBottom() && !chatState.hasLaterMessages) viewport.scrollToEnd();
		if (result === 'bounded') return;
	}
}
