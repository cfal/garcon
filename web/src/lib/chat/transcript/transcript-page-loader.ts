import {
	type ChatHistoryState,
	type TranscriptMessage,
	type TranscriptPage,
} from '$shared/chat-view';
import { loadTranscriptPageDemand } from './transcript-page-demand.js';
import {
	transcriptAnchorContinuation,
	transcriptAnchorWindow,
	TRANSCRIPT_ANCHOR_TARGET,
	type TranscriptAnchorRequest,
} from '$shared/transcript-anchor-page';
import { countTranscriptAnchors, loadTranscriptAnchorChunk, type TranscriptAnchorSnapshot } from './transcript-anchor-demand.js';
import {
	idlePageState,
	type TranscriptPageApplicationGate,
	type TranscriptPageDirection,
	type TranscriptPageLoadResult,
	type TranscriptPageState,
} from './transcript-page-progress.js';

interface TranscriptPageHost {
	readonly combinedMode: boolean;
	activeChatId: string | null;
	transcriptViewId: string;
	entries: TranscriptMessage[];
	lastOrdinal: number;
	nextBeforeOrdinal: number | null;
	loadedThroughOrdinal: number;
	hasEarlierMessages: boolean;
	hasLaterMessages: boolean;
	visibleMessageCount: number;
	readonly displayMessageCount: number;
	pageStates: Record<TranscriptPageDirection, TranscriptPageState>;
	loadMessages(chatId: string): Promise<unknown>;
	recoverTranscriptCursorAhead(chatId: string, transcriptViewId: string): Promise<void>;
}

interface TranscriptPageLoaderOptions {
	pageSize: number;
	onDemandSeeded(): void;
	onHistoryUnavailable(
		chatId: string,
		historyState: Exclude<ChatHistoryState, { kind: 'complete' }>,
	): void;
	onPageApplied(direction: TranscriptPageDirection): void;
	onEarlierPageProgress(chatId: string, requestBeforeOrdinal: number, page: TranscriptPage): void;
}

export interface TranscriptPageLoadOptions {
	applicationGate?: TranscriptPageApplicationGate;
	visibleLimit?: number;
	shouldContinue?: () => Promise<boolean>;
	preempt?: boolean;
}

export class TranscriptPageLoader {
	#loadPromise: Promise<TranscriptPageLoadResult> | null = null;
	#loadingChatId: string | null = null;
	#loadingDirection: TranscriptPageDirection | null = null;
	#operationEpoch = 0;
	#pending: Record<TranscriptPageDirection, TranscriptAnchorRequest | null> = {
		earlier: null,
		later: null,
	};

	constructor(
		private readonly host: TranscriptPageHost,
		private readonly options: TranscriptPageLoaderOptions,
	) {}

	hasPending(direction: TranscriptPageDirection): boolean {
		return this.#pending[direction] !== null;
	}

	isLoading(direction: TranscriptPageDirection): boolean {
		return this.#loadingDirection === direction && this.#loadPromise !== null;
	}

	seed(direction: TranscriptPageDirection, request: TranscriptAnchorRequest | null): void {
		this.#pending[direction] = this.host.combinedMode ? request : null;
		this.options.onDemandSeeded();
	}

	seedRestoredAnchorTarget(chatId: string): void {
		if (!this.host.combinedMode) return;
		this.#seedEarlierRemainder(chatId, TRANSCRIPT_ANCHOR_TARGET - countTranscriptAnchors(this.host.entries));
	}

	#seedEarlierRemainder(chatId: string, anchorsRemaining: number): void {
		this.seed('earlier', anchorsRemaining > 0 && this.host.nextBeforeOrdinal !== null ? {
			chatId, transcriptViewId: this.host.transcriptViewId, direction: 'backward',
			cursorOrdinal: this.host.nextBeforeOrdinal, anchorsRemaining,
		} : null);
	}

	seedAnchorSnapshot(chatId: string, snapshot: TranscriptAnchorSnapshot, olderAnchors = 0): void {
		const chunk = snapshot.finalChunk;
		if (chunk.direction === 'forward') {
			this.seed('later', chunk.endOrdinal - 1 === this.host.loadedThroughOrdinal
				? transcriptAnchorContinuation(chunk) : null);
		} else if (this.host.nextBeforeOrdinal === chunk.startOrdinal) {
			this.seed('earlier', transcriptAnchorContinuation(chunk));
		} else {
			this.#seedEarlierRemainder(chatId, chunk.anchorsRemaining - olderAnchors);
		}
	}

	load(
		direction: TranscriptPageDirection,
		chatId: string,
		options: TranscriptPageLoadOptions = {},
	): Promise<TranscriptPageLoadResult> {
		if (this.#loadPromise) {
			if (this.#loadingDirection === direction && this.#loadingChatId === chatId) {
				return this.#loadPromise;
			}
			if (!options.preempt) return Promise.resolve('invalidated');
			this.suspend();
		}
		if (!chatId || !this.#canLoad(direction)) return Promise.resolve('exhausted');

		const transcriptViewId = this.host.transcriptViewId;
		const operationEpoch = this.#operationEpoch;
		const loadedThroughOrdinal = this.host.loadedThroughOrdinal;
		const lastOrdinal = this.host.lastOrdinal;
		const retryError =
			this.host.pageStates[direction].status === 'error'
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
			options,
		);
		this.#loadPromise = loadPromise;
		this.#loadingChatId = chatId;
		this.#loadingDirection = direction;
		return loadPromise.finally(() => this.#finish(loadPromise, direction));
	}

	suspend(): void {
		this.#operationEpoch += 1;
		this.#loadPromise = null;
		this.#loadingChatId = null;
		this.#loadingDirection = null;
		for (const direction of ['earlier', 'later'] as const) {
			const pageState = this.host.pageStates[direction];
			if (pageState.status === 'loading') {
				this.host.pageStates[direction] = pageState.error
					? { status: 'error', error: pageState.error }
					: idlePageState();
			}
		}
	}

	invalidate(): void {
		this.suspend();
		this.#pending = { earlier: null, later: null };
		this.host.pageStates = { earlier: idlePageState(), later: idlePageState() };
	}

	#canLoad(direction: TranscriptPageDirection): boolean {
		if (this.host.combinedMode && this.hasPending(direction)) return true;
		return direction === 'earlier' ? this.host.hasEarlierMessages : this.host.hasLaterMessages;
	}

	async #performLoad(
		direction: TranscriptPageDirection,
		chatId: string,
		transcriptViewId: string,
		operationEpoch: number,
		loadedThroughOrdinal: number,
		lastOrdinal: number,
		options: TranscriptPageLoadOptions,
	): Promise<TranscriptPageLoadResult> {
		try {
			if (this.host.combinedMode) {
				return await this.#performAnchorLoad(
					direction,
					chatId,
					transcriptViewId,
					operationEpoch,
					options,
				);
			}
			if (direction === 'earlier') {
				return await this.#performEarlierLoad(chatId, transcriptViewId, operationEpoch, options);
			}
			return await this.#performLaterLoad(
				chatId,
				transcriptViewId,
				operationEpoch,
				loadedThroughOrdinal,
				lastOrdinal,
				options,
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

	async #performAnchorLoad(
		direction: TranscriptPageDirection,
		chatId: string,
		transcriptViewId: string,
		operationEpoch: number,
		options: TranscriptPageLoadOptions,
	): Promise<TranscriptPageLoadResult> {
		const boundary = () =>
			direction === 'earlier' ? this.host.nextBeforeOrdinal : this.host.loadedThroughOrdinal;
		const isCurrent = () => this.#isCurrent(chatId, transcriptViewId, operationEpoch);
		const cursorOrdinal = boundary();
		let request = this.#pending[direction];
		if (request?.transcriptViewId !== transcriptViewId || request.cursorOrdinal !== cursorOrdinal)
			request = null;
		if (cursorOrdinal === null) return 'exhausted';
		request ??= {
			chatId,
			transcriptViewId,
			cursorOrdinal,
			direction: direction === 'earlier' ? 'backward' : 'forward',
			anchorsRemaining: TRANSCRIPT_ANCHOR_TARGET,
		};
		this.#pending[direction] = request;
		while (isCurrent()) {
			if (options.shouldContinue && !(await options.shouldContinue())) return 'invalidated';
			if (!isCurrent() || boundary() !== request.cursorOrdinal) return 'invalidated';
			const result = await loadTranscriptAnchorChunk(request, isCurrent);
			if (result.kind === 'invalidated' || !isCurrent()) return 'invalidated';
			if (result.kind === 'cursor-ahead' || result.kind === 'view-changed') {
				await this.host.recoverTranscriptCursorAhead(chatId, transcriptViewId);
				return 'invalidated';
			}
			if (result.kind === 'unavailable') {
				this.options.onHistoryUnavailable(chatId, result.response.historyState);
				return 'invalidated';
			}
			if (
				!(await this.#canApply(chatId, transcriptViewId, operationEpoch, options.applicationGate))
			)
				return 'invalidated';
			if (boundary() !== request.cursorOrdinal) return 'invalidated';
			const page = result.page;
			const progressed = page.startOrdinal < page.endOrdinal;
			if (direction === 'earlier') {
				this.host.nextBeforeOrdinal = page.startOrdinal > 1 ? page.startOrdinal : null;
				this.host.hasEarlierMessages = this.host.nextBeforeOrdinal !== null;
				if (progressed) {
					this.host.entries = [...page.messages, ...this.host.entries];
					this.options.onEarlierPageProgress(chatId, page.endOrdinal, transcriptAnchorWindow(page));
				}
			} else {
				this.host.lastOrdinal = Math.max(this.host.lastOrdinal, page.lastOrdinal);
				this.host.loadedThroughOrdinal = page.endOrdinal - 1;
				this.host.hasLaterMessages = this.host.loadedThroughOrdinal < this.host.lastOrdinal;
				if (progressed) this.host.entries = [...this.host.entries, ...page.messages];
			}
			this.#pending[direction] = transcriptAnchorContinuation(page);
			if (progressed) this.options.onPageApplied(direction);
			if (!this.#pending[direction]) {
				return progressed || page.pageStatus === 'complete' ? 'loaded' : 'exhausted';
			}
			request = this.#pending[direction];
		}
		return 'invalidated';
	}

	async #performEarlierLoad(
		chatId: string,
		transcriptViewId: string,
		operationEpoch: number,
		options: TranscriptPageLoadOptions,
	): Promise<TranscriptPageLoadResult> {
		const requestBeforeOrdinal = this.host.nextBeforeOrdinal;
		if (requestBeforeOrdinal === null) return 'exhausted';
		const demand = await loadTranscriptPageDemand({
			direction: 'backward',
			chatId,
			transcriptViewId,
			beforeOrdinal: requestBeforeOrdinal,
			visibleLimit: options.visibleLimit ?? this.options.pageSize,
			isCurrent: () => this.#isCurrent(chatId, transcriptViewId, operationEpoch),
			onPageValidated: (request, page) => {
				if (request.beforeOrdinal === undefined) {
					throw new Error('Earlier transcript request has no raw boundary');
				}
				this.options.onEarlierPageProgress(chatId, request.beforeOrdinal, page);
			},
		});
		if (demand.kind === 'invalidated') return 'invalidated';
		if (
			!(await this.#canApply(chatId, transcriptViewId, operationEpoch, options.applicationGate))
		) {
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
		if (!finalPage) return 'exhausted';
		this.host.nextBeforeOrdinal = finalPage.nextBeforeOrdinal;
		this.host.hasEarlierMessages = finalPage.nextBeforeOrdinal !== null;
		this.host.lastOrdinal = Math.max(this.host.lastOrdinal, demand.lastOrdinal);
		this.host.hasLaterMessages = this.host.loadedThroughOrdinal < this.host.lastOrdinal;
		return demand.messages.length === 0 ? 'exhausted' : this.#applyEarlierMessages(demand.messages);
	}

	async #performLaterLoad(
		chatId: string,
		transcriptViewId: string,
		operationEpoch: number,
		loadedThroughOrdinal: number,
		lastOrdinal: number,
		options: TranscriptPageLoadOptions,
	): Promise<TranscriptPageLoadResult> {
		const demand = await loadTranscriptPageDemand({
			direction: 'later',
			chatId,
			transcriptViewId,
			afterOrdinal: loadedThroughOrdinal,
			throughOrdinal: lastOrdinal,
			visibleLimit: options.visibleLimit ?? this.options.pageSize,
			isCurrent: () => this.#isCurrent(chatId, transcriptViewId, operationEpoch),
		});
		if (demand.kind === 'invalidated') return 'invalidated';
		if (
			!(await this.#canApply(chatId, transcriptViewId, operationEpoch, options.applicationGate))
		) {
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
		if (!finalPage) return 'exhausted';
		return this.#applyLaterMessages(
			demand.messages,
			finalPage.pageNewestOrdinal,
			Math.max(lastOrdinal, demand.lastOrdinal),
		);
	}

	#applyEarlierMessages(messages: TranscriptMessage[]): TranscriptPageLoadResult {
		this.host.entries = [...messages, ...this.host.entries];
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
			this.#operationEpoch === operationEpoch &&
			this.host.activeChatId === chatId &&
			this.host.transcriptViewId === transcriptViewId
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
		this.#loadPromise = null;
		this.#loadingChatId = null;
		this.#loadingDirection = null;
		if (this.host.pageStates[direction].status === 'loading') {
			this.host.pageStates[direction] = idlePageState();
		}
	}
}
