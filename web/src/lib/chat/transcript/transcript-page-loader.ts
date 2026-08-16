import {
	type ChatHistoryState,
	type CompleteChatHistoryResponse,
	type TranscriptMessage,
} from '$shared/chat-view';
import { loadTranscriptPageDemand } from './transcript-page-demand.js';
import {
	idlePageState,
	type TranscriptPageDirection,
	type TranscriptPageLoadResult,
	type TranscriptPageState,
} from './transcript-page-progress.js';

type ChatPage = CompleteChatHistoryResponse;

interface TranscriptPageHost {
	activeChatId: string | null;
	transcriptViewId: string;
	entries: TranscriptMessage[];
	lastOrdinal: number;
	oldestOrdinal: number;
	nextBeforeOrdinal: number | null;
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
	onEarlierPageProgress(
		chatId: string,
		requestBeforeOrdinal: number,
		page: ChatPage,
	): void;
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
		const lastOrdinal = this.host.lastOrdinal;
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
			lastOrdinal,
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
		lastOrdinal: number,
	): Promise<TranscriptPageLoadResult> {
		try {
			if (direction === 'earlier') {
				return await this.#performEarlierLoad(
					chatId,
					transcriptViewId,
					operationEpoch,
				);
			}
			return await this.#performLaterLoad(
				chatId,
				transcriptViewId,
				operationEpoch,
				loadedThroughOrdinal,
				lastOrdinal,
			);
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

	async #performEarlierLoad(
		chatId: string,
		transcriptViewId: string,
		operationEpoch: number,
	): Promise<TranscriptPageLoadResult> {
		const requestBeforeOrdinal = this.host.nextBeforeOrdinal;
		if (requestBeforeOrdinal === null) return 'exhausted';
		const demand = await loadTranscriptPageDemand({
			direction: 'backward',
			chatId,
			transcriptViewId,
			beforeOrdinal: requestBeforeOrdinal,
			visibleLimit: this.options.pageSize,
			isCurrent: () => this.#isCurrent(chatId, transcriptViewId, operationEpoch),
			onPageValidated: (request, page) => {
				if (request.beforeOrdinal === undefined) {
					throw new Error('Earlier transcript request has no raw boundary');
				}
				this.options.onEarlierPageProgress(chatId, request.beforeOrdinal, page);
			},
		});
		if (demand.kind === 'invalidated') return 'invalidated';
		if (demand.kind === 'unavailable') {
			this.options.onHistoryUnavailable(chatId, demand.response.historyState);
			return 'invalidated';
		}
		if (demand.kind === 'view-changed') {
			await this.host.loadMessages(chatId);
			return 'invalidated';
		}
		const finalPage = demand.pages.at(-1);
		if (!finalPage) return 'exhausted';
		this.host.nextBeforeOrdinal = finalPage.nextBeforeOrdinal;
		this.host.hasEarlierMessages = finalPage.nextBeforeOrdinal !== null;
		this.host.lastOrdinal = Math.max(this.host.lastOrdinal, demand.lastOrdinal);
		this.host.hasLaterMessages = this.host.loadedThroughOrdinal < this.host.lastOrdinal;
		return demand.messages.length === 0
			? 'exhausted'
			: this.#applyEarlierMessages(demand.messages);
	}

	async #performLaterLoad(
		chatId: string,
		transcriptViewId: string,
		operationEpoch: number,
		loadedThroughOrdinal: number,
		lastOrdinal: number,
	): Promise<TranscriptPageLoadResult> {
		const demand = await loadTranscriptPageDemand({
			direction: 'later',
			chatId,
			transcriptViewId,
			afterOrdinal: loadedThroughOrdinal,
			throughOrdinal: lastOrdinal,
			visibleLimit: this.options.pageSize,
			isCurrent: () => this.#isCurrent(chatId, transcriptViewId, operationEpoch),
		});
		if (demand.kind === 'invalidated') return 'invalidated';
		if (demand.kind === 'unavailable') {
			this.options.onHistoryUnavailable(chatId, demand.response.historyState);
			return 'invalidated';
		}
		if (demand.kind === 'view-changed') {
			await this.host.loadMessages(chatId);
			return 'invalidated';
		}
		const finalPage = demand.pages.at(-1);
		if (!finalPage) return 'exhausted';
		return this.#applyLaterMessages(
			demand.messages,
			finalPage.pageNewestOrdinal,
			Math.max(lastOrdinal, demand.lastOrdinal),
		);
	}

	#applyEarlierMessages(messages: TranscriptMessage[]): TranscriptPageLoadResult {
		this.host.entries = [...messages, ...this.host.entries];
		this.host.oldestOrdinal = messages[0].ordinal;
		this.host.totalMessages = this.host.entries.length;
		this.host.visibleMessageCount += messages.length;
		this.options.onPageApplied('earlier');
		return 'loaded';
	}

	#applyLaterMessages(
		messages: TranscriptMessage[],
		pageNewestOrdinal: number,
		lastOrdinal: number,
	): TranscriptPageLoadResult {
		const reachesLatest = pageNewestOrdinal >= lastOrdinal;
		this.host.lastOrdinal = Math.max(this.host.lastOrdinal, lastOrdinal);
		this.host.loadedThroughOrdinal = pageNewestOrdinal;
		this.host.hasLaterMessages = !reachesLatest;
		if (messages.length === 0) {
			return 'loaded';
		}

		this.host.entries = [...this.host.entries, ...messages];
		this.host.oldestOrdinal = this.host.entries[0]?.ordinal ?? 0;
		this.host.totalMessages = this.host.entries.length;
		this.host.visibleMessageCount += messages.length;
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
