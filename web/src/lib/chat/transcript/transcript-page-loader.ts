import {
	type ChatHistoryState,
	type CompleteChatHistoryResponse,
	type TranscriptMessage,
} from '$shared/chat-view';
import { loadTranscriptPageDemand } from './transcript-page-demand.js';
import type { TranscriptReadBudget } from './transcript-read-budget.js';
import type { ConversationFeedMutationKind } from './conversation-feed-mutations.js';
import {
	idlePageState,
	type TranscriptPageApplicationGate,
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
	nextBeforeOrdinal: number | null;
	loadedThroughOrdinal: number;
	hasEarlierMessages: boolean;
	hasLaterMessages: boolean;
	pageStates: Record<TranscriptPageDirection, TranscriptPageState>;
	loadMessages(chatId: string): Promise<unknown>;
}

interface TranscriptPageLoaderOptions {
	pageSize: number;
	onHistoryUnavailable(
		chatId: string,
		historyState: Exclude<ChatHistoryState, { kind: 'complete' }>,
	): void;
	onPageApplied(kind: Extract<
		ConversationFeedMutationKind,
		'history-earlier' | 'history-later' | 'presentation-structure'
	>): void;
	onEarlierPageProgress(
		chatId: string,
		requestBeforeOrdinal: number,
		page: ChatPage,
	): void;
}

export interface TranscriptPageLoadOptions {
	applicationGate?: TranscriptPageApplicationGate;
	visibleLimit?: number;
	budget?: TranscriptReadBudget;
}

export class TranscriptPageLoader {
	#loadPromise: Promise<TranscriptPageLoadResult> | null = null;
	#loadingChatId: string | null = null;
	#loadingDirection: TranscriptPageDirection | null = null;
	#operationEpoch = 0;
	#abortController: AbortController | null = null;

	constructor(
		private readonly host: TranscriptPageHost,
		private readonly options: TranscriptPageLoaderOptions,
	) {}

	load(
		direction: TranscriptPageDirection,
		chatId: string,
		options: TranscriptPageLoadOptions = {},
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
		const abortController = new AbortController();
		this.#abortController = abortController;
		const loadedThroughOrdinal = this.host.loadedThroughOrdinal;
		const lastOrdinal = this.host.lastOrdinal;
		const retryError = this.host.pageStates[direction].status === 'error'
			? this.host.pageStates[direction].error
			: null;
		this.host.pageStates[direction] = {
			status: 'loading', error: retryError,
			...(this.host.pageStates[direction].status === 'bounded' ? { continuation: 'manual' as const } : {}),
		};
		const loadPromise = this.#performLoad(
			direction,
			chatId,
			transcriptViewId,
			operationEpoch,
			loadedThroughOrdinal,
			lastOrdinal,
			options,
			abortController.signal,
		);
		this.#loadPromise = loadPromise;
		this.#loadingChatId = chatId;
		this.#loadingDirection = direction;
		return loadPromise.finally(() => this.#finish(loadPromise, direction));
	}

	invalidate(): void {
		this.#operationEpoch += 1;
		this.#abortController?.abort();
		this.#abortController = null;
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
		options: TranscriptPageLoadOptions,
		signal: AbortSignal,
	): Promise<TranscriptPageLoadResult> {
		try {
			const result = direction === 'earlier'
				? await this.#performEarlierLoad(
					chatId,
					transcriptViewId,
					operationEpoch,
					options,
					signal,
				)
				: await this.#performLaterLoad(
				chatId,
				transcriptViewId,
				operationEpoch,
				loadedThroughOrdinal,
				lastOrdinal,
				options,
				signal,
			);
			if (result === 'bounded' && this.#isCurrent(chatId, transcriptViewId, operationEpoch)) {
				if (!this.#canLoad(direction)) {
					this.host.pageStates[direction] = idlePageState();
					return 'exhausted';
				}
				this.host.pageStates[direction] = { status: 'bounded', error: null };
			}
			return result;
		} catch (error) {
			if (signal.aborted || !this.#isCurrent(chatId, transcriptViewId, operationEpoch)) {
				return 'invalidated';
			}
			if (await this.#canApply(
				chatId,
				transcriptViewId,
				operationEpoch,
				options.applicationGate,
			)) {
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
		options: TranscriptPageLoadOptions,
		signal: AbortSignal,
	): Promise<TranscriptPageLoadResult> {
		const requestBeforeOrdinal = this.host.nextBeforeOrdinal;
		if (requestBeforeOrdinal === null) return 'exhausted';
		const demand = await loadTranscriptPageDemand({
			direction: 'backward',
			chatId,
			transcriptViewId,
			beforeOrdinal: requestBeforeOrdinal,
			visibleLimit: options.visibleLimit ?? this.options.pageSize,
			budget: options.budget,
			signal,
			isCurrent: () => this.#isCurrent(chatId, transcriptViewId, operationEpoch),
			onPageValidated: (request, page) => {
				if (request.beforeOrdinal === undefined) {
					throw new Error('Earlier transcript request has no raw boundary');
				}
				this.options.onEarlierPageProgress(chatId, request.beforeOrdinal, page);
			},
		});
		if (demand.kind === 'invalidated') return 'invalidated';
		if (!(await this.#canApply(
			chatId,
			transcriptViewId,
			operationEpoch,
			options.applicationGate,
		))) {
			return 'invalidated';
		}
		if (demand.kind === 'unavailable') {
			this.options.onHistoryUnavailable(chatId, demand.response.historyState);
			return 'invalidated';
		}
		if (demand.kind === 'view-changed') {
			await this.host.loadMessages(chatId);
			return 'invalidated';
		}
		const finalPage = demand.pages.at(-1);
		if (!finalPage) return demand.stop === 'budget' ? 'bounded' : 'exhausted';
		const previouslyHadLaterMessages = this.host.hasLaterMessages;
		this.host.nextBeforeOrdinal = finalPage.nextBeforeOrdinal;
		this.host.hasEarlierMessages = finalPage.nextBeforeOrdinal !== null;
		this.host.lastOrdinal = Math.max(this.host.lastOrdinal, demand.lastOrdinal);
		this.host.hasLaterMessages = this.host.loadedThroughOrdinal < this.host.lastOrdinal;
		if (demand.messages.length > 0) {
			this.#applyEarlierMessages(demand.messages);
			return demand.stop === 'budget' ? 'bounded' : 'loaded';
		}
		if (this.host.hasLaterMessages !== previouslyHadLaterMessages) {
			this.options.onPageApplied('presentation-structure');
		}
		return demand.stop === 'budget' ? 'bounded' : 'exhausted';
	}

	async #performLaterLoad(
		chatId: string,
		transcriptViewId: string,
		operationEpoch: number,
		loadedThroughOrdinal: number,
		lastOrdinal: number,
		options: TranscriptPageLoadOptions,
		signal: AbortSignal,
	): Promise<TranscriptPageLoadResult> {
		const demand = await loadTranscriptPageDemand({
			direction: 'later',
			chatId,
			transcriptViewId,
			afterOrdinal: loadedThroughOrdinal,
			throughOrdinal: lastOrdinal,
			visibleLimit: options.visibleLimit ?? this.options.pageSize,
			budget: options.budget,
			signal,
			isCurrent: () => this.#isCurrent(chatId, transcriptViewId, operationEpoch),
		});
		if (demand.kind === 'invalidated') return 'invalidated';
		if (!(await this.#canApply(
			chatId,
			transcriptViewId,
			operationEpoch,
			options.applicationGate,
		))) {
			return 'invalidated';
		}
		if (demand.kind === 'unavailable') {
			this.options.onHistoryUnavailable(chatId, demand.response.historyState);
			return 'invalidated';
		}
		if (demand.kind === 'view-changed') {
			await this.host.loadMessages(chatId);
			return 'invalidated';
		}
		const finalPage = demand.pages.at(-1);
		if (!finalPage) return demand.stop === 'budget' ? 'bounded' : 'exhausted';
		this.#applyLaterMessages(
			demand.messages,
			finalPage.pageNewestOrdinal,
			Math.max(lastOrdinal, demand.lastOrdinal),
		);
		return demand.stop === 'budget' ? 'bounded' : 'loaded';
	}

	#applyEarlierMessages(messages: TranscriptMessage[]): void {
		this.host.entries = [...messages, ...this.host.entries];
		this.options.onPageApplied('history-earlier');
	}

	#applyLaterMessages(
		messages: TranscriptMessage[],
		pageNewestOrdinal: number,
		lastOrdinal: number,
	): void {
		const incoming = messages.filter((entry) => entry.ordinal > this.host.loadedThroughOrdinal);
		const previouslyHadLaterMessages = this.host.hasLaterMessages;
		this.host.lastOrdinal = Math.max(this.host.lastOrdinal, lastOrdinal);
		this.host.loadedThroughOrdinal = Math.max(this.host.loadedThroughOrdinal, pageNewestOrdinal);
		this.host.hasLaterMessages = this.host.loadedThroughOrdinal < this.host.lastOrdinal;
		if (incoming.length === 0) {
			if (this.host.hasLaterMessages !== previouslyHadLaterMessages) {
				this.options.onPageApplied('presentation-structure');
			}
			return;
		}

		this.host.entries = [...this.host.entries, ...incoming];
		this.options.onPageApplied('history-later');
	}

	#isCurrent(chatId: string, transcriptViewId: string, operationEpoch: number): boolean {
		return (
			this.#operationEpoch === operationEpoch
			&& this.host.activeChatId === chatId
			&& this.host.transcriptViewId === transcriptViewId
		);
	}

	async #canApply(
		chatId: string,
		transcriptViewId: string,
		operationEpoch: number,
		applicationGate: TranscriptPageApplicationGate | undefined,
	): Promise<boolean> {
		if (!this.#isCurrent(chatId, transcriptViewId, operationEpoch)) return false;
		if (applicationGate && (await applicationGate()) !== 'apply') return false;
		return this.#isCurrent(chatId, transcriptViewId, operationEpoch);
	}

	#finish(
		loadPromise: Promise<TranscriptPageLoadResult>,
		direction: TranscriptPageDirection,
	): void {
		if (this.#loadPromise !== loadPromise) return;
		this.#abortController = null;
		this.#loadPromise = null;
		this.#loadingChatId = null;
		this.#loadingDirection = null;
		if (this.host.pageStates[direction].status === 'loading') {
			this.host.pageStates[direction] = this.host.pageStates[direction].continuation === 'manual' && this.#canLoad(direction)
				? { status: 'bounded', error: null }
				: idlePageState();
		}
	}
}
