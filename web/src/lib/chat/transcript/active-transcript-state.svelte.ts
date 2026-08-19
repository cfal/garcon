import {
	applyTranscriptAppend,
	type ChatHistoryState,
	type ResendCandidate,
	type TranscriptMessage,
	type TranscriptPage,
} from '$shared/chat-view';
import type { ChatMessage } from '$shared/chat-types';
import { ChatTranscriptCache } from './chat-transcript-cache.svelte';
import type { LocalNoticeRow, LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import { TranscriptNoticeFeed } from './transcript-notice-feed.svelte.js';
import { TranscriptOptimisticInputs } from './transcript-optimistic-inputs.svelte.js';
import { TranscriptResendCandidates } from './transcript-resend-candidates.svelte.js';
import type { OptimisticUserInput } from './optimistic-user-input.js';
import { ConversationFeedMutationState } from './ConversationFeedMutationState.svelte.js';
import type {
	ActiveTranscriptPort,
	ChatCursor,
	ChatLoadMessagesOptions,
	ChatRestoreResult,
} from './active-transcript-port.js';
import {
	idlePageState,
	mergeTranscriptEntriesByOrdinal,
	retainTranscriptEntries,
	retainedEarlierPageCursor,
	type TranscriptPageApplicationGate,
	type TranscriptPageDirection,
	type TranscriptPageLoadResult,
	type TranscriptPageState,
	type TranscriptWindowLoadResult,
	type TranscriptWindowTarget,
} from './transcript-page-progress.js';
import { TranscriptPageLoader } from './transcript-page-loader.js';
import {
	collapseBackwardTranscriptDemand,
	loadTranscriptPageDemand,
} from './transcript-page-demand.js';
import {
	loadTranscriptWindowPage,
	preferCachedLatestTranscriptPage,
	transcriptSnapshotInstallMode,
	type TranscriptSnapshotInstallMode,
} from './transcript-window-loader.js';
import {
	TranscriptReconnectReplayState,
	type TranscriptBufferedBatch,
	type TranscriptReplayApplyResult,
} from './transcript-reconnect-replay.js';
import { displayLocalNotices } from './degraded-history-notice.js';
import {
	echoedClientMessageOrdinals,
	echoedClientMessageIds,
	hasEarlierTranscriptRowsToReveal,
	messagesFromDisplayRows,
	responseMessageTypesAfter,
	transcriptDisplayRows,
	visibleOptimisticTranscriptInputs,
	visibleTranscriptRows,
	type ChatDisplayRow,
} from './transcript-row-projection.js';
export type {
	ActiveTranscriptPort,
	ChatCursor,
	ChatLoadMessagesOptions,
	ChatRestoreResult,
} from './active-transcript-port.js';
export type { ChatDisplayRow, ChatTranscriptRow } from './transcript-row-projection.js';

const MESSAGES_PER_PAGE = 50;
export const INITIAL_VISIBLE_MESSAGES = 100;
type ActiveTranscriptSnapshot = TranscriptPage & { resendCandidates?: ResendCandidate[] };
export type MessageApplyResult = TranscriptReplayApplyResult;
type PageApplyResult = MessageApplyResult | 'stale';

function retainedWindow(
	messages: TranscriptMessage[],
	edge: 'earlier' | 'later',
	nextBeforeOrdinal: number | null,
): { retainedMessages: TranscriptMessage[]; nextBeforeOrdinal: number | null } {
	const retainedMessages = retainTranscriptEntries(messages, edge);
	return {
		retainedMessages,
		nextBeforeOrdinal: retainedEarlierPageCursor(
			messages,
			retainedMessages,
			nextBeforeOrdinal,
		),
	};
}

export type ChatLoadStatus = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';

export class ActiveTranscriptState implements ActiveTranscriptPort {
	readonly transcriptCache: ChatTranscriptCache;
	activeChatId = $state<string | null>(null);
	entries = $state<TranscriptMessage[]>([]);
	#resend = new TranscriptResendCandidates();
	transcriptViewId = $state('');
	windowRevision = $state(0);
	lastOrdinal = $state(0);
	nextBeforeOrdinal = $state<number | null>(null);
	loadedThroughOrdinal = $state(0);
	hasLaterMessages = $state(false);
	visibleMessageCount = $state(INITIAL_VISIBLE_MESSAGES);
	isLoadingMessages = $state(false);
	hasEarlierMessages = $state(false);
	pageStates = $state<Record<TranscriptPageDirection, TranscriptPageState>>({
		earlier: idlePageState(),
		later: idlePageState(),
	});
	isUserScrolledUp = $state(false);
	loadStatus = $state<ChatLoadStatus>('idle');
	loadError = $state<string | null>(null);
	historyState = $state<ChatHistoryState>({ kind: 'complete' });
	#snapshotBuffer: TranscriptBufferedBatch[] | null = null;
	#reconnectReplay = new TranscriptReconnectReplayState((chatId, batch) => this.applyMessages(
		chatId,
		batch.transcriptViewId,
		batch.messages,
		batch.firstOrdinal,
		batch.lastOrdinal,
		batch.resendCandidates,
		batch.noticeRevision,
	));
	#loadEpoch = 0;
	#notices = new TranscriptNoticeFeed();
	#optimisticInputs = new TranscriptOptimisticInputs(() => {
		this.#growExpandedVisibleWindow();
		this.#feedMutations.record('presentation-structure');
	});
	#windowNavigationEpoch = 0;
	#expandedVisibleStartOrdinal: number | null = null;
	#feedMutations = new ConversationFeedMutationState();
	#pageLoader: TranscriptPageLoader;

	constructor(transcriptCache = new ChatTranscriptCache({ limit: INITIAL_VISIBLE_MESSAGES })) {
		this.transcriptCache = transcriptCache;
		this.#pageLoader = new TranscriptPageLoader(this, {
			pageSize: MESSAGES_PER_PAGE,
			onHistoryUnavailable: (chatId, historyState) => {
				this.#setUnavailableHistory(chatId, historyState);
			},
			onPageApplied: (direction) => {
				this.#rememberExpandedVisibleWindow();
				this.#feedMutations.record(
					direction === 'earlier' ? 'history-earlier' : 'history-later',
				);
			},
			onEarlierPageProgress: (chatId, requestBeforeOrdinal, page) => {
				this.transcriptCache.applyEarlierPage(
					chatId,
					page.transcriptViewId,
					requestBeforeOrdinal,
					page,
				);
			},
		});
	}

	get localNotices(): (LocalNoticeRow & { revision: number })[] {
		return this.#notices.rows;
	}

	get optimisticUserInputs(): OptimisticUserInput[] {
		return this.#optimisticInputs.rows;
	}

	get resendCandidates(): readonly ResendCandidate[] {
		return this.#resend.included;
	}

	get excludedResendOrdinals(): readonly number[] {
		return this.#resend.excludedOrdinals;
	}

	setResendCandidates(candidates: readonly ResendCandidate[]): void {
		this.#resend.replace(candidates);
	}

	excludeResendCandidate(ordinal: number): void {
		this.#resend.exclude(ordinal);
	}

	clearResendExclusions(): void {
		this.#resend.clearExclusions();
	}

	#echoedClientMessageIds = $derived(echoedClientMessageIds(this.entries));

	#displayLocalNotices = $derived(
		displayLocalNotices(this.hasLaterMessages, this.historyState, this.localNotices),
	);

	#displayRows = $derived(transcriptDisplayRows({
		entries: this.entries,
		transcriptViewId: this.transcriptViewId,
		optimisticInputs: this.visibleOptimisticInputs,
		optimisticAfterOrdinals: this.#optimisticInputs.afterOrdinalByClientMessageId,
		notices: this.#displayLocalNotices,
	}));

	#visibleRows = $derived(visibleTranscriptRows({
		entries: this.entries,
		transcriptViewId: this.transcriptViewId,
		optimisticInputs: this.visibleOptimisticInputs,
		optimisticAfterOrdinals: this.#optimisticInputs.afterOrdinalByClientMessageId,
		notices: this.#displayLocalNotices,
		visibleCount: this.visibleMessageCount,
	}));

	get chatMessages(): ChatMessage[] {
		return this.entries.map((entry) => entry.message);
	}

	get feedMutationClock() {
		return this.#feedMutations.clock;
	}

	get displayMessages(): ChatMessage[] {
		return messagesFromDisplayRows(this.#displayRows);
	}

	get displayRows(): readonly ChatDisplayRow[] {
		return this.#displayRows;
	}

	get visibleRows(): ChatDisplayRow[] {
		return this.#visibleRows;
	}

	get displayMessageCount(): number {
		return this.entries.length + this.visibleOptimisticInputs.length + this.#displayLocalNotices.length;
	}

	get visibleMessages(): ChatMessage[] {
		return messagesFromDisplayRows(this.#visibleRows);
	}

	get hasEarlierRowsToReveal(): boolean {
		return hasEarlierTranscriptRowsToReveal(this.#visibleRows, this.entries);
	}

	get canLoadEarlier(): boolean {
		return this.hasEarlierRowsToReveal || this.hasEarlierMessages;
	}

	get visibleOptimisticInputs(): OptimisticUserInput[] {
		return visibleOptimisticTranscriptInputs(
			this.hasLaterMessages,
			this.optimisticUserInputs,
			this.#echoedClientMessageIds,
		);
	}

	getCursor(): ChatCursor {
		const cached = this.activeChatId
			? this.transcriptCache.readAppliedCursor(this.activeChatId)
			: null;
		const lastOrdinal = cached
			&& !cached.stale
			&& cached.transcriptViewId === this.transcriptViewId
			? Math.min(cached.lastOrdinal, this.lastOrdinal)
			: Math.min(this.loadedThroughOrdinal, this.lastOrdinal);
		return { transcriptViewId: this.transcriptViewId, lastOrdinal };
	}

	beginReconnectReplay(chatId: string, transcriptViewId: string): number {
		return this.#reconnectReplay.begin(chatId, transcriptViewId);
	}

	applyReconnectReplayPage(
		token: number,
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		firstOrdinal: number,
		lastOrdinal: number,
		resendCandidates: ResendCandidate[],
	): MessageApplyResult | 'stale' {
		return this.#reconnectReplay.applyPage(token, chatId, {
			transcriptViewId,
			messages,
			firstOrdinal,
			lastOrdinal,
			resendCandidates,
			noticeRevision: this.#notices.revision,
		});
	}

	finishReconnectReplay(token: number, chatId: string): MessageApplyResult | 'stale' {
		return this.#reconnectReplay.finish(token, chatId);
	}

	abortReconnectReplay(token: number): void {
		this.#reconnectReplay.abort(token);
	}

	applyMessages(
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		firstOrdinal: number,
		lastOrdinal: number,
		resendCandidates: ResendCandidate[] = [...this.#resend.all],
		noticeRevision = this.#notices.revision,
	): MessageApplyResult {
		if (this.historyState.kind !== 'complete') {
			this.transcriptCache.markStale(chatId);
			return 'gap-detected';
		}
		const appliedFrontierOrdinal = Math.min(this.loadedThroughOrdinal, this.lastOrdinal);
		const append = { firstOrdinal, lastOrdinal, messages };
		const bufferedBatch = { transcriptViewId, ...append, noticeRevision, resendCandidates };
		if (this.#snapshotBuffer) {
			this.transcriptCache.applyMessages(chatId, transcriptViewId, append);
			this.#snapshotBuffer.push(bufferedBatch);
			return 'applied';
		}
		if (this.#reconnectReplay.buffer(chatId, bufferedBatch)) {
			return 'applied';
		}
		if (this.transcriptViewId && transcriptViewId !== this.transcriptViewId) {
			this.#invalidatePageLoad();
			this.transcriptCache.markStale(chatId);
			return 'view-changed';
		}
		const result = this.transcriptCache.applyMessages(chatId, transcriptViewId, append);
		if (result.status === 'view-changed') {
			this.#invalidatePageLoad();
			this.transcriptCache.markStale(chatId);
			return 'view-changed';
		}
		if (result.status !== 'applied') {
			const gapDetails =
				result.status === 'gap-detected'
					? ` expected=${result.expectedOrdinal} received=${result.receivedOrdinal}`
					: '';
			console.warn(
				`[chat-state] transcript apply failed chat=${chatId} generation=${transcriptViewId} status=${result.status}${gapDetails}`,
			);
			return 'gap-detected';
		}
		const responseMessageTypes = responseMessageTypesAfter(messages, appliedFrontierOrdinal);
		const observedHeadAdvanced = result.lastOrdinal > this.lastOrdinal;
		this.lastOrdinal = Math.max(this.lastOrdinal, result.lastOrdinal);
		if (this.hasLaterMessages && firstOrdinal > appliedFrontierOrdinal + 1) {
			const cacheStateChanged = result.changed || observedHeadAdvanced;
			this.transcriptViewId = transcriptViewId;
			if (cacheStateChanged) {
				this.clearLocalNotices(noticeRevision);
			}
			if (this.entries.length > 0 && this.loadStatus !== 'error') {
				this.loadStatus = 'loaded';
			}
			if (cacheStateChanged) {
				this.#feedMutations.record('live-append', responseMessageTypes);
			}
			this.#optimisticInputs.clearEchoed(echoedClientMessageOrdinals(messages));
			this.setResendCandidates(resendCandidates);
			return 'applied';
		}
		const previousEntryCount = this.entries.length;
		const applied = applyTranscriptAppend(this.entries, append, appliedFrontierOrdinal);
		let entriesChanged = applied.status === 'applied' && applied.changed;
		if (applied.status === 'applied') {
			this.transcriptViewId = transcriptViewId;
			if (applied.messages !== this.entries) this.entries = applied.messages;
			this.loadedThroughOrdinal = applied.lastOrdinal;
			this.hasLaterMessages = this.loadedThroughOrdinal < this.lastOrdinal;
			if (entriesChanged && this.isUserScrolledUp) {
				const appendedCount = Math.max(0, this.entries.length - previousEntryCount);
				this.visibleMessageCount = Math.min(
					this.displayMessageCount,
					this.visibleMessageCount + appendedCount,
				);
			}
		} else {
			const restored = this.transcriptCache.get(chatId);
			if (!restored || restored.transcriptViewId !== transcriptViewId) return 'gap-detected';
			this.#invalidatePageLoad();
			entriesChanged = true;
			this.transcriptViewId = restored.transcriptViewId;
			this.entries = retainTranscriptEntries(restored.messages, 'later');
			this.lastOrdinal = restored.lastOrdinal;
			this.nextBeforeOrdinal = restored.nextBeforeOrdinal;
			this.hasEarlierMessages = restored.nextBeforeOrdinal !== null;
		}
		if (entriesChanged) {
			this.clearLocalNotices(noticeRevision);
		}
		if (entriesChanged) this.#growExpandedVisibleWindow();
		if (this.entries.length > 0 && this.loadStatus !== 'error') {
			this.loadStatus = 'loaded';
		}
		if (entriesChanged) {
			this.#feedMutations.record('live-append', responseMessageTypes);
		}
		this.#optimisticInputs.clearEchoed(echoedClientMessageOrdinals(messages));
		this.setResendCandidates(resendCandidates);
		return 'applied';
	}

	beginSnapshotLoad(): number {
		const epoch = this.#beginLoadEpoch();
		this.#snapshotBuffer ??= [];
		this.isLoadingMessages = true;
		this.loadStatus = 'loading';
		this.loadError = null;
		return epoch;
	}

	abortSnapshotLoad(epoch: number): void {
		if (epoch !== this.#loadEpoch) return;
		this.#snapshotBuffer = null;
		this.isLoadingMessages = false;
	}

	#finishFailedSnapshotLoad(chatId: string, epoch: number): boolean {
		if (epoch !== this.#loadEpoch) return false;
		if (this.activeChatId && this.activeChatId !== chatId) {
			this.abortSnapshotLoad(epoch);
			return false;
		}

		const buffered = this.#snapshotBuffer ?? [];
		this.#snapshotBuffer = null;
		this.isLoadingMessages = false;
		for (const batch of buffered) {
			if (this.applyMessages(
				chatId,
				batch.transcriptViewId,
				batch.messages,
				batch.firstOrdinal,
				batch.lastOrdinal,
				batch.resendCandidates,
				batch.noticeRevision,
			) !== 'applied') break;
		}
		return true;
	}

	replaceGeneration(
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		options: Pick<
			TranscriptPage,
			'lastOrdinal' | 'pageOldestOrdinal' | 'nextBeforeOrdinal' | 'hasMore'
		> & {
			pageNewestOrdinal?: number;
			resendCandidates?: ResendCandidate[];
		},
	): void {
		const { retainedMessages, nextBeforeOrdinal } = retainedWindow(
			messages,
			'later',
			options.nextBeforeOrdinal,
		);
		const pageNewestOrdinal = options.pageNewestOrdinal ?? options.lastOrdinal;
		this.#invalidatePageLoad();
		this.#expandedVisibleStartOrdinal = null;
		this.historyState = { kind: 'complete' };
		this.activeChatId = chatId;
		this.#loadEpoch += 1;
		this.#snapshotBuffer = null;
		this.#reconnectReplay.reset();
		this.transcriptCache.replaceFromPage(chatId, {
			transcriptViewId,
			messages,
			lastOrdinal: options.lastOrdinal,
			pageOldestOrdinal: options.pageOldestOrdinal,
			pageNewestOrdinal,
			nextBeforeOrdinal: options.nextBeforeOrdinal,
			hasMore: options.hasMore,
		});
		this.windowRevision += 1;
		this.transcriptViewId = transcriptViewId;
		this.entries = retainedMessages;
		this.lastOrdinal = options.lastOrdinal;
		this.loadedThroughOrdinal = pageNewestOrdinal;
		this.nextBeforeOrdinal = nextBeforeOrdinal;
		this.hasEarlierMessages = nextBeforeOrdinal !== null;
		this.hasLaterMessages = pageNewestOrdinal < options.lastOrdinal;
		this.#optimisticInputs.clearAll();
		this.setResendCandidates(options.resendCandidates ?? []);
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.#notices.reset();
		this.loadStatus = messages.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		this.#feedMutations.record('replacement');
	}

	setFromPage(
		chatId: string,
		page: ActiveTranscriptSnapshot,
		epoch: number,
	): PageApplyResult {
		return this.#installSnapshotPage(chatId, page, epoch);
	}

	#installSnapshotPage(
		chatId: string,
		page: ActiveTranscriptSnapshot,
		epoch: number,
		requiredInstallMode?: TranscriptSnapshotInstallMode,
	): PageApplyResult {
		if (epoch !== this.#loadEpoch) return 'stale';

		const buffered = this.#snapshotBuffer ?? [];
		this.#snapshotBuffer = null;
		const hasBufferedGenerationChange = buffered.some(
			(batch) => batch.transcriptViewId !== page.transcriptViewId,
		);
		if (hasBufferedGenerationChange) {
			this.#invalidatePageLoad();
			this.isLoadingMessages = false;
			return 'view-changed';
		}

		this.#reconnectReplay.reset();
		this.#invalidatePageLoad();
		this.historyState = { kind: 'complete' };
		const installMode = requiredInstallMode ?? transcriptSnapshotInstallMode({
			activeChatId: this.activeChatId,
			chatId,
			transcriptViewId: this.transcriptViewId,
			entryCount: this.entries.length,
			loadedThroughOrdinal: this.loadedThroughOrdinal,
			nextBeforeOrdinal: this.nextBeforeOrdinal,
			page,
		});
		if (installMode === 'merge') this.#mergeSnapshot(chatId, page);
		else if (installMode === 'preserve-window') this.#preserveWindowFromSnapshot(chatId, page);
		else this.#replaceFromSnapshot(chatId, page);
		this.setResendCandidates(page.resendCandidates ?? []);
		this.clearLocalNotices(this.#notices.revisionAtLoadStart);
		this.loadStatus = this.entries.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		for (const batch of buffered) {
			const result = this.applyMessages(
				chatId,
				batch.transcriptViewId,
				batch.messages,
				batch.firstOrdinal,
				batch.lastOrdinal,
				batch.resendCandidates,
				batch.noticeRevision,
			);
			if (result !== 'applied') return result;
		}
		return 'applied';
	}

	#mergeSnapshot(chatId: string, page: ActiveTranscriptSnapshot): void {
		const previousEntries = this.entries;
		const previousLastOrdinal = this.lastOrdinal;
		const previousLoadedThroughOrdinal = this.loadedThroughOrdinal;
		const mergedEntries = mergeTranscriptEntriesByOrdinal(previousEntries, page.messages);
		const mergedLastOrdinal = Math.max(previousLastOrdinal, page.lastOrdinal);
		const mergedLoadedThroughOrdinal = Math.max(
			previousLoadedThroughOrdinal,
			page.pageNewestOrdinal,
		);
		const pageExtendsEarlier = this.nextBeforeOrdinal !== null
			&& (
				page.nextBeforeOrdinal === null
				|| page.nextBeforeOrdinal <= this.nextBeforeOrdinal
			);
		const nextBeforeOrdinal = pageExtendsEarlier
			? page.nextBeforeOrdinal
			: this.nextBeforeOrdinal;
		this.transcriptCache.replaceFromPage(chatId, {
			...page,
			messages: mergedEntries,
			lastOrdinal: mergedLastOrdinal,
			pageOldestOrdinal: mergedEntries[0]?.ordinal ?? 0,
			pageNewestOrdinal: mergedLoadedThroughOrdinal,
			nextBeforeOrdinal,
			hasMore: nextBeforeOrdinal !== null,
		});
		this.entries = mergedEntries;
		this.lastOrdinal = mergedLastOrdinal;
		this.loadedThroughOrdinal = mergedLoadedThroughOrdinal;
		this.nextBeforeOrdinal = nextBeforeOrdinal;
		this.hasEarlierMessages = nextBeforeOrdinal !== null;
		this.hasLaterMessages = mergedLoadedThroughOrdinal < mergedLastOrdinal;
		this.#growExpandedVisibleWindow();
		this.#optimisticInputs.clearEchoed(echoedClientMessageOrdinals(page.messages));

		const cursorAdvanced = mergedLastOrdinal > previousLastOrdinal;
		if (mergedEntries === previousEntries && !cursorAdvanced) return;
		const preservesExistingPrefix = previousEntries.every(
			(entry, index) => mergedEntries[index] === entry,
		);
		if (preservesExistingPrefix) {
			this.#feedMutations.record(
				'live-append',
				responseMessageTypesAfter(page.messages, previousLastOrdinal),
			);
		} else {
			this.#feedMutations.record('presentation-structure');
		}
	}

	#preserveWindowFromSnapshot(chatId: string, page: ActiveTranscriptSnapshot): void {
		const previouslyHadLaterMessages = this.hasLaterMessages;
		this.transcriptCache.replaceFromPage(chatId, page);
		this.lastOrdinal = Math.max(this.lastOrdinal, page.lastOrdinal);
		this.hasLaterMessages = this.loadedThroughOrdinal < this.lastOrdinal;
		this.#optimisticInputs.clearEchoed(echoedClientMessageOrdinals(page.messages));
		this.#growExpandedVisibleWindow();
		if (this.hasLaterMessages !== previouslyHadLaterMessages) {
			this.#feedMutations.record('presentation-structure');
		}
	}

	#replaceFromSnapshot(chatId: string, page: ActiveTranscriptSnapshot): void {
		const replacesTranscriptView = this.transcriptViewId !== ''
			&& page.transcriptViewId !== this.transcriptViewId;
		this.transcriptCache.replaceFromPage(chatId, page);
		this.windowRevision += 1;
		if (replacesTranscriptView) {
			this.#expandedVisibleStartOrdinal = null;
			this.visibleMessageCount = Math.min(this.visibleMessageCount, INITIAL_VISIBLE_MESSAGES);
		}
		const { retainedMessages, nextBeforeOrdinal } = retainedWindow(
			page.messages,
			'later',
			page.nextBeforeOrdinal,
		);
		this.transcriptViewId = page.transcriptViewId;
		this.entries = retainedMessages;
		this.lastOrdinal = page.lastOrdinal;
		this.loadedThroughOrdinal = page.pageNewestOrdinal;
		this.nextBeforeOrdinal = nextBeforeOrdinal;
		this.hasEarlierMessages = nextBeforeOrdinal !== null;
		this.hasLaterMessages = page.pageNewestOrdinal < page.lastOrdinal;
		if (replacesTranscriptView) this.#optimisticInputs.clearAll();
		else this.#optimisticInputs.clearEchoed(echoedClientMessageOrdinals(page.messages));
		this.#feedMutations.record('replacement');
	}

	async loadMessages(
		chatId: string,
		options: ChatLoadMessagesOptions = {},
	): Promise<ChatMessage[]> {
		if (!chatId) return [];
		const limit = Math.max(
			MESSAGES_PER_PAGE,
			Math.floor(options.minimumLimit ?? MESSAGES_PER_PAGE),
		);
		const maxAttempts = 2;

		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const epoch = this.beginSnapshotLoad();
			try {
				const demand = await loadTranscriptPageDemand({
					direction: 'backward',
					chatId,
					visibleLimit: limit,
					purpose: 'activation',
					isCurrent: () => (
						epoch === this.#loadEpoch
						&& (!this.activeChatId || this.activeChatId === chatId)
					),
				});
				if (demand.kind === 'invalidated') {
					this.abortSnapshotLoad(epoch);
					return this.chatMessages;
				}
				if (demand.kind === 'unavailable') {
					if (epoch !== this.#loadEpoch) return this.chatMessages;
					this.#setUnavailableHistory(chatId, demand.response.historyState);
					return [];
				}
				if (demand.kind === 'view-changed') {
					this.abortSnapshotLoad(epoch);
					continue;
				}
				const page = collapseBackwardTranscriptDemand(demand);
				const result = this.setFromPage(chatId, page, epoch);

				if (result === 'applied') return this.chatMessages;
				if (result === 'stale') return this.chatMessages;

				this.abortSnapshotLoad(epoch);
			} catch (error) {
				if (this.#finishFailedSnapshotLoad(chatId, epoch)) {
					this.loadStatus = 'error';
					this.loadError = error instanceof Error ? error.message : 'Failed to load messages';
				}
				throw error;
			}
		}

		this.loadStatus = 'error';
		this.loadError = 'Chat generation changed while loading messages';
		throw new Error(this.loadError);
	}

	async loadEarlierPage(
		chatId: string,
		applicationGate?: TranscriptPageApplicationGate,
	): Promise<TranscriptPageLoadResult> {
		return this.#pageLoader.load('earlier', chatId, applicationGate);
	}

	async loadLaterPage(
		chatId: string,
		applicationGate?: TranscriptPageApplicationGate,
	): Promise<TranscriptPageLoadResult> {
		return this.#pageLoader.load('later', chatId, applicationGate);
	}

	invalidatePendingHistoryLoad(): void {
		this.#invalidatePageLoad();
	}

	invalidatePendingWindowNavigation(): void {
		this.#windowNavigationEpoch += 1;
	}

	#invalidatePageLoad(): void {
		this.#pageLoader.invalidate();
	}

	appendLocalNotice(noticeType: LocalNoticeType, content: string): void {
		this.#notices.append(noticeType, content);
		this.#growExpandedVisibleWindow();
		this.#feedMutations.record('presentation-structure');
	}

	// Routes a server-issued overlay notice by its chat identity: the active
	// conversation shows it immediately, any other chat retains it until that
	// chat activates. Retention is bounded per chat and dropped with the chat.
	appendServerNotice(chatId: string, noticeType: LocalNoticeType, content: string): void {
		if (chatId === this.activeChatId) this.appendLocalNotice(noticeType, content);
		else this.#notices.retain(chatId, noticeType, content);
	}

	discardServerNotices(chatId: string): void {
		this.#notices.discard(chatId);
	}

	#drainServerNotices(chatId: string): void {
		if (!this.#notices.drain(chatId)) return;
		this.#growExpandedVisibleWindow();
		this.#feedMutations.record('presentation-structure');
	}

	clearLocalNotices(throughRevision?: number): void {
		if (!this.#notices.clearThrough(throughRevision)) return;
		this.#growExpandedVisibleWindow();
		this.#feedMutations.record('presentation-structure');
	}

	upsertOptimisticUserInput(input: OptimisticUserInput): void {
		this.clearLocalNotices();
		if (this.#echoedClientMessageIds.has(input.clientMessageId)) return;
		this.#optimisticInputs.upsert(input, this.lastOrdinal);
	}

	markOptimisticUserInputDelivered(clientMessageId: string): void {
		this.#optimisticInputs.markDelivered(clientMessageId);
	}

	clearOptimisticUserInput(clientMessageId: string): void {
		this.#optimisticInputs.clear(clientMessageId);
	}

	clearMessages(): void {
		this.#resetToEmptyTranscript();
		this.loadStatus = 'idle';
		this.historyState = { kind: 'complete' };
		this.#feedMutations.record('replacement');
	}

	#resetToEmptyTranscript(): void {
		this.#invalidatePageLoad();
		this.#expandedVisibleStartOrdinal = null;
		this.#loadEpoch += 1;
		this.windowRevision += 1;
		this.entries = [];
		this.transcriptViewId = '';
		this.lastOrdinal = 0;
		this.nextBeforeOrdinal = null;
		this.loadedThroughOrdinal = 0;
		this.#optimisticInputs.clearAll();
		this.#resend.clear();
		this.#notices.reset();
		this.hasEarlierMessages = false;
		this.hasLaterMessages = false;
		this.loadError = null;
		this.isLoadingMessages = false;
		this.#snapshotBuffer = null;
		this.#reconnectReplay.reset();
	}

	revealEarlierLoadedRows(): boolean {
		const previousCount = this.visibleMessageCount;
		const nextCount = Math.min(this.displayMessageCount, previousCount + 100);
		if (nextCount <= previousCount) return false;
		this.visibleMessageCount = nextCount;
		this.pageStates.earlier = idlePageState();
		this.#rememberExpandedVisibleWindow();
		this.#feedMutations.record('history-earlier');
		return true;
	}

	revealAllLoadedMessages(): void {
		const changed = this.visibleMessageCount < this.displayMessageCount;
		this.visibleMessageCount = Math.max(this.visibleMessageCount, this.displayMessageCount);
		this.#rememberExpandedVisibleWindow();
		if (changed) this.#feedMutations.record('initial');
	}

	async navigateToWindow(
		chatId: string,
		target: TranscriptWindowTarget,
	): Promise<TranscriptWindowLoadResult> {
		if (!chatId || this.activeChatId !== chatId) return 'invalidated';
		if (this.#snapshotBuffer) return 'invalidated';
		const alreadyAtTarget = target === 'latest'
			? !this.hasLaterMessages
			: !this.hasEarlierMessages;

		const windowNavigationEpoch = ++this.#windowNavigationEpoch;
		const loadEpoch = this.#beginLoadEpoch();
		this.#invalidatePageLoad();
		this.isLoadingMessages = false;
		if (alreadyAtTarget) return 'loaded';

		const transcriptViewId = this.transcriptViewId;
		const latestLastOrdinal = this.lastOrdinal;

		try {
			const isCurrent = () => (
				windowNavigationEpoch === this.#windowNavigationEpoch
				&& loadEpoch === this.#loadEpoch
				&& this.activeChatId === chatId
				&& this.transcriptViewId === transcriptViewId
			);
			const result = await loadTranscriptWindowPage({
				chatId,
				target,
				transcriptViewId,
				lastOrdinal: latestLastOrdinal,
				visibleLimit: MESSAGES_PER_PAGE,
				isCurrent,
			});
			if (result.kind === 'invalidated') return 'invalidated';
			if (result.kind === 'unavailable') {
				this.#setUnavailableHistory(chatId, result.response.historyState);
				return 'loaded';
			}
			if (result.kind === 'view-changed') {
				this.transcriptCache.markStale(chatId);
				return 'invalidated';
			}
			const page = result.page;

			if (target === 'latest') {
				const latestPage = preferCachedLatestTranscriptPage(
					page,
					this.transcriptCache.get(chatId),
					this.#resend.all,
				);
				return this.#installSnapshotPage(chatId, latestPage, loadEpoch, 'replace') === 'applied'
					? 'loaded'
					: 'invalidated';
			}

			this.#expandedVisibleStartOrdinal = null;
			this.windowRevision += 1;
			const { retainedMessages, nextBeforeOrdinal } = retainedWindow(
				page.messages,
				'earlier',
				page.nextBeforeOrdinal,
			);
			this.entries = retainedMessages;
			this.lastOrdinal = page.lastOrdinal;
			this.nextBeforeOrdinal = nextBeforeOrdinal;
			this.loadedThroughOrdinal = page.pageNewestOrdinal;
			this.hasEarlierMessages = nextBeforeOrdinal !== null;
			this.hasLaterMessages = page.pageNewestOrdinal < page.lastOrdinal;
			this.visibleMessageCount = retainedMessages.length;
			if (this.hasLaterMessages) {
				this.isUserScrolledUp = true;
			}
			this.loadStatus = page.messages.length === 0 ? 'empty' : 'loaded';
			this.loadError = null;
			this.#feedMutations.record('replacement');
			return 'loaded';
		} catch (error) {
			if (
				windowNavigationEpoch !== this.#windowNavigationEpoch ||
				loadEpoch !== this.#loadEpoch ||
				this.activeChatId !== chatId ||
				this.transcriptViewId !== transcriptViewId
			) {
				return 'invalidated';
			}
			console.error(`Error loading ${target} messages:`, error);
			return 'failed';
		}
	}

	#beginLoadEpoch(): number {
		this.#notices.markLoadStart();
		return ++this.#loadEpoch;
	}

	resetForNewChat(): void {
		this.clearMessages();
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.isUserScrolledUp = false;
	}

	#setUnavailableHistory(
		chatId: string,
		historyState: Exclude<ChatHistoryState, { kind: 'complete' }>,
	): void {
		this.activeChatId = chatId;
		this.transcriptCache.remove(chatId);
		this.#resetToEmptyTranscript();
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.loadStatus = 'loaded';
		this.historyState = historyState;
		this.#feedMutations.record('replacement');
	}

	activateChat(chatId: string | null): ChatRestoreResult | null {
		this.activeChatId = chatId;
		this.resetForNewChat();
		if (!chatId) return null;
		this.#drainServerNotices(chatId);
		// Publishes the bounded cache window atomically; the virtual feed limits mounted row work.
		const restored = this.transcriptCache.get(chatId);
		if (!restored) return null;
		const retainedMessages = retainTranscriptEntries(restored.messages, 'later');
		this.entries = retainedMessages;
		this.transcriptViewId = restored.transcriptViewId;
		this.lastOrdinal = restored.lastOrdinal;
		this.loadedThroughOrdinal = restored.lastOrdinal;
		this.nextBeforeOrdinal = restored.nextBeforeOrdinal;
		// Preserves the earlier boundary across cache restore so validation cannot insert it after paint.
		this.hasEarlierMessages = restored.nextBeforeOrdinal !== null;
		this.hasLaterMessages = false;
		this.loadStatus = retainedMessages.length === 0 ? 'empty' : 'loaded';
		return { count: retainedMessages.length, stale: restored.stale };
	}

	removeCachedMessages(chatId: string): void {
		this.transcriptCache.remove(chatId);
	}

	#rememberExpandedVisibleWindow(): void {
		if (this.entries.length <= INITIAL_VISIBLE_MESSAGES) return;
		let firstVisibleOrdinal: number | undefined;
		for (const row of this.#visibleRows) {
			if (row.kind !== 'message' || row.ordinal === undefined) continue;
			firstVisibleOrdinal = row.ordinal;
			break;
		}
		if (firstVisibleOrdinal === undefined) return;
		this.#expandedVisibleStartOrdinal = firstVisibleOrdinal;
		this.#growExpandedVisibleWindow();
	}

	#growExpandedVisibleWindow(): void {
		if (this.#expandedVisibleStartOrdinal === null) return;
		const firstVisibleIndex = this.#displayRows.findIndex(
			(row) => row.kind === 'message' && row.ordinal === this.#expandedVisibleStartOrdinal,
		);
		if (firstVisibleIndex === -1) {
			this.#expandedVisibleStartOrdinal = null;
			return;
		}
		this.visibleMessageCount = this.#displayRows.length - firstVisibleIndex;
	}
}
