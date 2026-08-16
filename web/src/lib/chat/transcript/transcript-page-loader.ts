import {
	isUnavailableChatHistoryResponse,
	type ChatHistoryState,
	type TranscriptMessage,
} from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';
import {
	idlePageState,
	validateEarlierTranscriptPage,
	type TranscriptPageDirection,
	type TranscriptPageLoadResult,
	type TranscriptPageState,
} from './transcript-page-progress.js';

type ChatHistoryPage = Awaited<ReturnType<typeof getChatMessages>>;
type ChatPage = Extract<ChatHistoryPage, { historyState: { kind: 'complete' } }>;

interface TranscriptPageHost {
	activeChatId: string | null;
	transcriptViewId: string;
	entries: TranscriptMessage[];
	lastOrdinal: number;
	oldestOrdinal: number;
	loadedThroughOrdinal: number;
	hasEarlierMessages: boolean;
	hasLaterMessages: boolean;
	totalMessages: number;
	visibleMessageCount: number;
	readonly displayMessageCount: number;
	pageStates: Record<TranscriptPageDirection, TranscriptPageState>;
	loadMessages(chatId: string): Promise<unknown>;
}

interface TranscriptPageLoaderOptions {
	pageSize: number;
	onHistoryUnavailable(
		chatId: string,
		historyState: Exclude<ChatHistoryState, { kind: 'complete' }>,
	): void;
	onPageApplied(direction: TranscriptPageDirection): void;
}

export class TranscriptPageLoader {
	#loadPromise: Promise<TranscriptPageLoadResult> | null = null;
	#loadingChatId: string | null = null;
	#loadingDirection: TranscriptPageDirection | null = null;
	#operationEpoch = 0;

	constructor(
		private readonly host: TranscriptPageHost,
		private readonly options: TranscriptPageLoaderOptions,
	) {}

	load(
		direction: TranscriptPageDirection,
		chatId: string,
	): Promise<TranscriptPageLoadResult> {
		if (this.#loadPromise) {
			if (this.#loadingDirection === direction && this.#loadingChatId === chatId) {
				return this.#loadPromise;
			}
			return Promise.resolve('invalidated');
		}
		if (!chatId || !this.#canLoad(direction)) return Promise.resolve('exhausted');

		const transcriptViewId = this.host.transcriptViewId;
		const operationEpoch = this.#operationEpoch;
		const loadedThroughOrdinal = this.host.loadedThroughOrdinal;
		const retryError = this.host.pageStates[direction].status === 'error'
			? this.host.pageStates[direction].error
			: null;
		this.host.pageStates[direction] = { status: 'loading', error: retryError };
		const loadPromise = this.#performLoad(
			direction,
			chatId,
			transcriptViewId,
			operationEpoch,
			loadedThroughOrdinal,
		);
		this.#loadPromise = loadPromise;
		this.#loadingChatId = chatId;
		this.#loadingDirection = direction;
		return loadPromise.finally(() => this.#finish(loadPromise, direction));
	}

	invalidate(): void {
		this.#operationEpoch += 1;
		this.#loadPromise = null;
		this.#loadingChatId = null;
		this.#loadingDirection = null;
		this.host.pageStates = { earlier: idlePageState(), later: idlePageState() };
	}

	#canLoad(direction: TranscriptPageDirection): boolean {
		return direction === 'earlier'
			? this.host.hasEarlierMessages
			: this.host.hasLaterMessages;
	}

	async #performLoad(
		direction: TranscriptPageDirection,
		chatId: string,
		transcriptViewId: string,
		operationEpoch: number,
		loadedThroughOrdinal: number,
	): Promise<TranscriptPageLoadResult> {
		try {
			const page = await getChatMessages({
				chatId,
				limit: this.options.pageSize,
				beforeOrdinal: this.#beforeOrdinal(direction, loadedThroughOrdinal),
				transcriptViewId,
			});
			if (!this.#isCurrent(chatId, transcriptViewId, operationEpoch)) {
				return 'invalidated';
			}
			if (isUnavailableChatHistoryResponse(page)) {
				this.options.onHistoryUnavailable(chatId, page.historyState);
				return 'invalidated';
			}
			if (page.transcriptViewId !== transcriptViewId) {
				await this.host.loadMessages(chatId);
				return 'invalidated';
			}
			return direction === 'earlier'
				? this.#applyEarlierPage(page)
				: this.#applyLaterPage(page, loadedThroughOrdinal);
		} catch (error) {
			if (this.#isCurrent(chatId, transcriptViewId, operationEpoch)) {
				this.host.pageStates[direction] = {
					status: 'error',
					error: error instanceof Error ? error.message : 'Page load failed',
				};
			}
			console.error(`Error loading ${direction} messages:`, error);
			return 'failed';
		}
	}

	#beforeOrdinal(direction: TranscriptPageDirection, loadedThroughOrdinal: number): number {
		if (direction === 'earlier') return this.host.oldestOrdinal;
		return Math.min(
			loadedThroughOrdinal + this.options.pageSize + 1,
			this.host.lastOrdinal + 1,
		);
	}

	#applyEarlierPage(page: ChatPage): TranscriptPageLoadResult {
		validateEarlierTranscriptPage(page, this.host.oldestOrdinal);
		if (page.messages.length === 0) {
			this.host.hasEarlierMessages = false;
			return 'exhausted';
		}

		this.host.entries = [...page.messages, ...this.host.entries];
		this.host.oldestOrdinal = page.messages[0].ordinal;
		this.host.lastOrdinal = Math.max(this.host.lastOrdinal, page.lastOrdinal);
		this.host.hasEarlierMessages = page.hasMore;
		this.host.totalMessages = this.host.entries.length;
		this.host.visibleMessageCount += page.messages.length;
		this.options.onPageApplied('earlier');
		return 'loaded';
	}

	#applyLaterPage(
		page: ChatPage,
		loadedThroughOrdinal: number,
	): TranscriptPageLoadResult {
		const reachesLatest = page.pageNewestOrdinal >= page.lastOrdinal;
		const addedMessages = page.messages.filter((entry) => entry.ordinal > loadedThroughOrdinal);
		if (addedMessages.length === 0) {
			if (page.pageNewestOrdinal <= loadedThroughOrdinal) {
				throw new Error('Later transcript page did not advance the loaded window');
			}
			this.host.loadedThroughOrdinal = page.pageNewestOrdinal;
			this.host.hasLaterMessages = !reachesLatest;
			return 'loaded';
		}

		this.host.entries = [...this.host.entries, ...addedMessages];
		this.host.lastOrdinal = Math.max(this.host.lastOrdinal, page.lastOrdinal);
		this.host.loadedThroughOrdinal = page.pageNewestOrdinal;
		this.host.oldestOrdinal = this.host.entries[0]?.ordinal ?? 0;
		this.host.hasLaterMessages = !reachesLatest;
		this.host.totalMessages = this.host.entries.length;
		this.host.visibleMessageCount += addedMessages.length;
		if (reachesLatest) {
			this.host.visibleMessageCount = Math.min(
				this.host.visibleMessageCount,
				this.host.displayMessageCount,
			);
		}
		this.options.onPageApplied('later');
		return 'loaded';
	}

	#isCurrent(chatId: string, transcriptViewId: string, operationEpoch: number): boolean {
		return (
			this.#operationEpoch === operationEpoch
			&& this.host.activeChatId === chatId
			&& this.host.transcriptViewId === transcriptViewId
		);
	}

	#finish(
		loadPromise: Promise<TranscriptPageLoadResult>,
		direction: TranscriptPageDirection,
	): void {
		if (this.#loadPromise !== loadPromise) return;
		this.#loadPromise = null;
		this.#loadingChatId = null;
		this.#loadingDirection = null;
		if (this.host.pageStates[direction].status === 'loading') {
			this.host.pageStates[direction] = idlePageState();
		}
	}
}
