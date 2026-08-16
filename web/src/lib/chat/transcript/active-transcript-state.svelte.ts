import {
	applyTranscriptAppend,
	isUnavailableChatHistoryResponse,
	type ChatHistoryState,
	type ResendCandidate,
	type TranscriptMessage,
	type TranscriptPage,
} from '$shared/chat-view';
import type { ChatMessage } from '$shared/chat-types';
import { ChatTranscriptCache } from './chat-transcript-cache.svelte';
import { getChatMessages } from '$lib/api/chats.js';
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
	ACTIVE_TRANSCRIPT_RETENTION_LIMIT,
	idlePageState,
	mergeTranscriptEntriesByOrdinal,
	retainTranscriptEntries,
	validateEarlierTranscriptPage,
	type TranscriptPageDirection,
	type TranscriptPageLoadResult,
	type TranscriptPageState,
	type TranscriptWindowLoadResult,
	type TranscriptWindowTarget,
} from './transcript-page-progress.js';
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
type ChatHistoryPage = Awaited<ReturnType<typeof getChatMessages>>;
type ChatPage = Extract<ChatHistoryPage, { historyState: { kind: 'complete' } }>;
type ActiveTranscriptSnapshot = TranscriptPage & { resendCandidates?: ResendCandidate[] };
type SnapshotInstallMode = 'merge' | 'preserve-window' | 'replace';
export type MessageApplyResult = TranscriptReplayApplyResult;
type PageApplyResult = MessageApplyResult | 'stale';

export type ChatLoadStatus = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';

export class ActiveTranscriptState implements ActiveTranscriptPort {
	readonly transcriptCache: ChatTranscriptCache;
	activeChatId = $state<string | null>(null);
	entries = $state<TranscriptMessage[]>([]);
	#resend = new TranscriptResendCandidates();
	transcriptViewId = $state('');
	windowRevision = $state(0);
	lastOrdinal = $state(0);
	oldestOrdinal = $state(0);
	loadedThroughOrdinal = $state(0);
	hasLaterMessages = $state(false);
	visibleMessageCount = $state(INITIAL_VISIBLE_MESSAGES);
	isLoadingMessages = $state(false);
	hasEarlierMessages = $state(false);
	pageStates = $state<Record<TranscriptPageDirection, TranscriptPageState>>({
		earlier: idlePageState(),
		later: idlePageState(),
	});
	totalMessages = $state(0);
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
	#pageLoadPromise: Promise<TranscriptPageLoadResult> | null = null;
	#loadingPageChatId: string | null = null;
	#loadingPageDirection: TranscriptPageDirection | null = null;
	#pageLoadOperationEpoch = 0;
	#windowNavigationEpoch = 0;
	#expandedVisibleStartOrdinal: number | null = null;
	#feedMutations = new ConversationFeedMutationState();

	constructor(transcriptCache = new ChatTranscriptCache({ limit: INITIAL_VISIBLE_MESSAGES })) {
		this.transcriptCache = transcriptCache;
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

	get newestLoadedOrdinal(): number {
		return this.entries.at(-1)?.ordinal ?? 0;
	}

	get hasEarlierRowsToReveal(): boolean {
		return hasEarlierTranscriptRowsToReveal(this.#visibleRows, this.entries);
	}

	get canLoadEarlier(): boolean {
		return this.hasEarlierRowsToReveal || this.hasEarlierMessages;
	}

	get canAutoFillEarlier(): boolean {
		return this.hasEarlierRowsToReveal || this.hasEarlierMessages;
	}

	get canLoadLater(): boolean {
		return this.hasLaterMessages;
	}

	get visibleOptimisticInputs(): OptimisticUserInput[] {
		return visibleOptimisticTranscriptInputs(
			this.hasLaterMessages,
			this.optimisticUserInputs,
			this.#echoedClientMessageIds,
		);
	}

	getCursor(): ChatCursor {
		return { transcriptViewId: this.transcriptViewId, lastOrdinal: this.lastOrdinal };
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
		const previousLastOrdinal = this.lastOrdinal;
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
		const responseMessageTypes = responseMessageTypesAfter(messages, previousLastOrdinal);
		const cursorAdvanced = result.lastOrdinal > previousLastOrdinal;
		if (this.hasLaterMessages) {
			this.transcriptViewId = transcriptViewId;
			this.lastOrdinal = result.lastOrdinal;
			if (result.changed || cursorAdvanced) {
				this.clearLocalNotices(noticeRevision);
			}
			if (this.entries.length > 0 && this.loadStatus !== 'error') {
				this.loadStatus = 'loaded';
			}
			if (result.changed || cursorAdvanced) {
				this.#feedMutations.record('live-append', responseMessageTypes);
			}
			this.#optimisticInputs.clearEchoed(echoedClientMessageOrdinals(messages));
			this.setResendCandidates(resendCandidates);
			return 'applied';
		}
		const previousEntryCount = this.entries.length;
		const applied = applyTranscriptAppend(this.entries, append, this.lastOrdinal);
		let entriesChanged = applied.status === 'applied' && applied.changed;
		if (applied.status === 'applied') {
			this.transcriptViewId = transcriptViewId;
			if (applied.messages !== this.entries) this.entries = applied.messages;
			this.lastOrdinal = applied.lastOrdinal;
			this.loadedThroughOrdinal = applied.lastOrdinal;
			this.oldestOrdinal = this.entries[0]?.ordinal ?? 0;
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
			this.oldestOrdinal = this.entries[0]?.ordinal ?? 0;
		}
		if (entriesChanged) {
			this.clearLocalNotices(noticeRevision);
		}
		this.totalMessages = this.entries.length;
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
		options: Pick<TranscriptPage, 'lastOrdinal' | 'pageOldestOrdinal' | 'hasMore'> & {
			pageNewestOrdinal?: number;
			resendCandidates?: ResendCandidate[];
		},
	): void {
		const retainedMessages = retainTranscriptEntries(messages, 'later');
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
			hasMore: options.hasMore,
		});
		this.windowRevision += 1;
		this.transcriptViewId = transcriptViewId;
		this.entries = retainedMessages;
		this.lastOrdinal = options.lastOrdinal;
		this.loadedThroughOrdinal = pageNewestOrdinal;
		this.oldestOrdinal = retainedMessages[0]?.ordinal ?? 0;
		this.hasEarlierMessages = options.hasMore || retainedMessages.length < messages.length;
		this.hasLaterMessages = false;
		this.totalMessages = retainedMessages.length;
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

	#replaceFromNavigationPage(
		chatId: string,
		page: ActiveTranscriptSnapshot,
		epoch: number,
	): PageApplyResult {
		return this.#installSnapshotPage(chatId, page, epoch, 'replace');
	}

	#installSnapshotPage(
		chatId: string,
		page: ActiveTranscriptSnapshot,
		epoch: number,
		requiredInstallMode?: SnapshotInstallMode,
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
		const installMode = requiredInstallMode ?? this.#snapshotInstallMode(chatId, page);
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

	#snapshotInstallMode(chatId: string, page: ActiveTranscriptSnapshot): SnapshotInstallMode {
		if (
			this.activeChatId !== chatId
			|| this.transcriptViewId === ''
			|| this.transcriptViewId !== page.transcriptViewId
			|| this.entries.length === 0
		) {
			return 'replace';
		}
		const intervalsTouch = page.pageOldestOrdinal <= this.loadedThroughOrdinal + 1
			&& this.oldestOrdinal <= page.pageNewestOrdinal + 1;
		return intervalsTouch ? 'merge' : 'preserve-window';
	}

	#mergeSnapshot(chatId: string, page: ActiveTranscriptSnapshot): void {
		const previousEntries = this.entries;
		const previousLastOrdinal = this.lastOrdinal;
		const previousLoadedThroughOrdinal = this.loadedThroughOrdinal;
		const previousOldestOrdinal = this.oldestOrdinal;
		const mergedEntries = mergeTranscriptEntriesByOrdinal(previousEntries, page.messages);
		const mergedLastOrdinal = Math.max(previousLastOrdinal, page.lastOrdinal);
		const mergedLoadedThroughOrdinal = Math.max(
			previousLoadedThroughOrdinal,
			page.pageNewestOrdinal,
		);
		const pageExtendsEarlier = page.pageOldestOrdinal <= previousOldestOrdinal;
		const hasEarlierMessages = pageExtendsEarlier ? page.hasMore : this.hasEarlierMessages;
		this.transcriptCache.replaceFromPage(chatId, {
			...page,
			messages: mergedEntries,
			lastOrdinal: mergedLastOrdinal,
			pageOldestOrdinal: mergedEntries[0]?.ordinal ?? 0,
			pageNewestOrdinal: mergedLoadedThroughOrdinal,
			hasMore: hasEarlierMessages,
		});
		this.entries = mergedEntries;
		this.lastOrdinal = mergedLastOrdinal;
		this.loadedThroughOrdinal = mergedLoadedThroughOrdinal;
		this.oldestOrdinal = mergedEntries[0]?.ordinal ?? 0;
		this.hasEarlierMessages = hasEarlierMessages;
		this.hasLaterMessages = mergedLoadedThroughOrdinal < mergedLastOrdinal;
		this.totalMessages = mergedEntries.length;
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
		const retainedMessages = retainTranscriptEntries(page.messages, 'later');
		this.transcriptViewId = page.transcriptViewId;
		this.entries = retainedMessages;
		this.lastOrdinal = page.lastOrdinal;
		this.loadedThroughOrdinal = page.pageNewestOrdinal;
		this.oldestOrdinal = retainedMessages[0]?.ordinal ?? 0;
		this.hasEarlierMessages = page.hasMore || retainedMessages.length < page.messages.length;
		this.hasLaterMessages = false;
		this.totalMessages = retainedMessages.length;
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
				const page = await getChatMessages({ chatId, limit });
				if (this.activeChatId && this.activeChatId !== chatId) {
					this.abortSnapshotLoad(epoch);
					return this.chatMessages;
				}
				if (isUnavailableChatHistoryResponse(page)) {
					if (epoch !== this.#loadEpoch) return this.chatMessages;
					this.#setUnavailableHistory(chatId, page.historyState);
					return [];
				}
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

	async loadEarlierPage(chatId: string): Promise<TranscriptPageLoadResult> {
		return this.#loadPage('earlier', chatId);
	}

	async loadLaterPage(chatId: string): Promise<TranscriptPageLoadResult> {
		return this.#loadPage('later', chatId);
	}

	async #loadPage(
		direction: TranscriptPageDirection,
		chatId: string,
	): Promise<TranscriptPageLoadResult> {
		if (this.#pageLoadPromise) {
			return this.#loadingPageDirection === direction && this.#loadingPageChatId === chatId
				? this.#pageLoadPromise
				: 'invalidated';
		}
		if (!chatId || (direction === 'earlier' ? !this.hasEarlierMessages : !this.hasLaterMessages)) {
			return 'exhausted';
		}

		const transcriptViewId = this.transcriptViewId;
		const operationEpoch = this.#pageLoadOperationEpoch;
		const loadedThroughOrdinal = this.loadedThroughOrdinal;
		const retryError =
			this.pageStates[direction].status === 'error' ? this.pageStates[direction].error : null;
		this.pageStates[direction] = { status: 'loading', error: retryError };
		const loadPromise = this.#performPageLoad(
			direction,
			chatId,
			transcriptViewId,
			operationEpoch,
			loadedThroughOrdinal,
		);
		this.#pageLoadPromise = loadPromise;
		this.#loadingPageChatId = chatId;
		this.#loadingPageDirection = direction;
		try {
			return await loadPromise;
		} finally {
			if (this.#pageLoadPromise === loadPromise) {
				this.#pageLoadPromise = null;
				this.#loadingPageChatId = null;
				this.#loadingPageDirection = null;
				if (this.pageStates[direction].status === 'loading') {
					this.pageStates[direction] = idlePageState();
				}
			}
		}
	}

	async #performPageLoad(
		direction: TranscriptPageDirection,
		chatId: string,
		transcriptViewId: string,
		operationEpoch: number,
		loadedThroughOrdinal: number,
	): Promise<TranscriptPageLoadResult> {
		try {
			const beforeOrdinal = direction === 'earlier'
				? this.oldestOrdinal
				: Math.min(loadedThroughOrdinal + MESSAGES_PER_PAGE + 1, this.lastOrdinal + 1);
			const page = await getChatMessages(
				{ chatId, limit: MESSAGES_PER_PAGE, beforeOrdinal, transcriptViewId },
			);
			if (!this.#isCurrentPageLoad(chatId, transcriptViewId, operationEpoch)) {
				return 'invalidated';
			}
			if (isUnavailableChatHistoryResponse(page)) {
				this.#setUnavailableHistory(chatId, page.historyState);
				return 'invalidated';
			}
			if (page.transcriptViewId !== transcriptViewId) {
				await this.loadMessages(chatId);
				return 'invalidated';
			}
			return direction === 'earlier'
				? this.#applyEarlierPage(page)
				: this.#applyLaterPage(page, loadedThroughOrdinal);
		} catch (error) {
			if (this.#isCurrentPageLoad(chatId, transcriptViewId, operationEpoch)) {
				this.pageStates[direction] = {
					status: 'error',
					error: error instanceof Error ? error.message : 'Page load failed',
				};
			}
			console.error(`Error loading ${direction} messages:`, error);
			return 'failed';
		}
	}

	#applyEarlierPage(page: ChatPage): TranscriptPageLoadResult {
		validateEarlierTranscriptPage(page, this.oldestOrdinal);
		if (page.messages.length === 0) {
			this.hasEarlierMessages = false;
			return 'exhausted';
		}
		const addedMessages = page.messages;
		const mergedEntries = [...addedMessages, ...this.entries];
		this.entries = mergedEntries;
		this.oldestOrdinal = addedMessages[0].ordinal;
		this.lastOrdinal = Math.max(this.lastOrdinal, page.lastOrdinal);
		this.hasEarlierMessages = page.hasMore;
		this.totalMessages = this.entries.length;
		this.visibleMessageCount += addedMessages.length;
		this.#rememberExpandedVisibleWindow();
		this.#feedMutations.record('history-earlier');
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
			this.loadedThroughOrdinal = page.pageNewestOrdinal;
			this.hasLaterMessages = !reachesLatest;
			return 'loaded';
		}

		const merged = [...this.entries, ...addedMessages];
		this.entries = merged;
		this.lastOrdinal = Math.max(this.lastOrdinal, page.lastOrdinal);
		this.loadedThroughOrdinal = page.pageNewestOrdinal;
		this.oldestOrdinal = this.entries[0]?.ordinal ?? 0;
		this.hasLaterMessages = !reachesLatest;
		this.totalMessages = this.entries.length;
		this.visibleMessageCount += addedMessages.length;
		if (reachesLatest) {
			this.visibleMessageCount = Math.min(this.visibleMessageCount, this.displayMessageCount);
		}
		this.#rememberExpandedVisibleWindow();
		this.#feedMutations.record('history-later');
		return 'loaded';
	}

	invalidatePendingHistoryLoad(): void {
		this.#invalidatePageLoad();
	}

	invalidatePendingWindowNavigation(): void {
		this.#windowNavigationEpoch += 1;
	}

	#isCurrentPageLoad(chatId: string, transcriptViewId: string, operationEpoch: number): boolean {
		return (
			this.#pageLoadOperationEpoch === operationEpoch &&
			this.activeChatId === chatId &&
			this.transcriptViewId === transcriptViewId
		);
	}

	#invalidatePageLoad(): void {
		this.#pageLoadOperationEpoch += 1;
		this.#pageLoadPromise = null;
		this.#loadingPageChatId = null;
		this.#loadingPageDirection = null;
		this.pageStates = { earlier: idlePageState(), later: idlePageState() };
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
		this.oldestOrdinal = 0;
		this.loadedThroughOrdinal = 0;
		this.#optimisticInputs.clearAll();
		this.#resend.clear();
		this.#notices.reset();
		this.hasEarlierMessages = false;
		this.hasLaterMessages = false;
		this.totalMessages = 0;
		this.loadError = null;
		this.isLoadingMessages = false;
		this.#snapshotBuffer = null;
		this.#reconnectReplay.reset();
	}

	compactToRecentMessages(): boolean {
		if (this.entries.length <= ACTIVE_TRANSCRIPT_RETENTION_LIMIT) return false;
		this.entries = this.entries.slice(-ACTIVE_TRANSCRIPT_RETENTION_LIMIT);
		this.oldestOrdinal = this.entries[0]?.ordinal ?? 0;
		this.totalMessages = this.entries.length;
		this.hasEarlierMessages = true;
		this.visibleMessageCount = Math.min(this.visibleMessageCount, INITIAL_VISIBLE_MESSAGES);
		this.#expandedVisibleStartOrdinal = null;
		this.#feedMutations.record('history-pruned');
		return true;
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
			const page = await getChatMessages(
				target === 'initial'
					? {
							chatId,
							limit: MESSAGES_PER_PAGE,
							beforeOrdinal: Math.min(latestLastOrdinal + 1, MESSAGES_PER_PAGE + 1),
							transcriptViewId,
						}
					: { chatId, limit: MESSAGES_PER_PAGE, transcriptViewId },
			);
			if (
				windowNavigationEpoch !== this.#windowNavigationEpoch ||
				loadEpoch !== this.#loadEpoch ||
				this.activeChatId !== chatId ||
				this.transcriptViewId !== transcriptViewId
			) {
				return 'invalidated';
			}
			if (isUnavailableChatHistoryResponse(page)) {
				this.#setUnavailableHistory(chatId, page.historyState);
				return 'loaded';
			}
			if (page.transcriptViewId !== transcriptViewId) {
				this.transcriptCache.markStale(chatId);
				return 'invalidated';
			}

			if (target === 'latest') {
				const cached = this.transcriptCache.get(chatId);
				const latestPage =
					cached &&
					!cached.stale &&
					cached.transcriptViewId === page.transcriptViewId &&
					cached.lastOrdinal > page.lastOrdinal
						? {
								...page,
								messages: cached.messages,
								lastOrdinal: cached.lastOrdinal,
								pageOldestOrdinal: cached.oldestOrdinal,
								pageNewestOrdinal: cached.lastOrdinal,
								resendCandidates: [...this.#resend.all],
							}
						: page;
				return this.#replaceFromNavigationPage(chatId, latestPage, loadEpoch) === 'applied'
					? 'loaded'
					: 'invalidated';
			}

			this.#expandedVisibleStartOrdinal = null;
			this.windowRevision += 1;
			const retainedMessages = retainTranscriptEntries(page.messages, 'earlier');
			this.entries = retainedMessages;
			this.oldestOrdinal = retainedMessages[0]?.ordinal ?? 0;
			this.loadedThroughOrdinal = page.pageNewestOrdinal;
			this.hasEarlierMessages = false;
			this.hasLaterMessages = page.pageNewestOrdinal < page.lastOrdinal;
			this.totalMessages = retainedMessages.length;
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
		this.oldestOrdinal = retainedMessages[0]?.ordinal ?? 0;
		this.totalMessages = retainedMessages.length;
		// Preserves the earlier boundary across cache restore so validation cannot insert it after paint.
		this.hasEarlierMessages =
			restored.oldestOrdinal > 1 || retainedMessages.length < restored.messages.length;
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
