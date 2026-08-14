import {
	applyTranscriptAppend,
	isUnavailableChatHistoryResponse,
	type ChatHistoryState,
	type ResendCandidate,
	type TranscriptAppend,
	type TranscriptMessage,
	type TranscriptPage,
} from '$shared/chat-view';
import type { ChatMessage } from '$shared/chat-types';
import { ChatTranscriptCache } from './chat-transcript-cache.svelte';
import { getChatMessages } from '$lib/api/chats.js';
import type { LocalNoticeRow, LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import { TranscriptNoticeFeed } from './transcript-notice-feed.svelte.js';
import { TranscriptOptimisticInputs } from './transcript-optimistic-inputs.svelte.js';
import type { OptimisticUserInput } from './optimistic-user-input.js';
import { ConversationFeedMutationState } from './ConversationFeedMutationState.svelte.js';
import type { ConversationFeedMutationKind } from './conversation-feed-mutations.js';
import type {
	ActiveTranscriptPort,
	ChatCursor,
	ChatLoadMessagesOptions,
	ChatRestoreResult,
} from './active-transcript-port.js';
import {
	ACTIVE_TRANSCRIPT_RETENTION_LIMIT,
	collectEarlierTranscriptMessages,
	idlePageState,
	retainTranscriptEntries,
	type TranscriptPageDirection,
	type TranscriptPageLoadResult,
	type TranscriptPageState,
	type TranscriptWindowLoadResult,
	type TranscriptWindowTarget,
} from './transcript-page-progress.js';
import { displayLocalNotices } from './degraded-history-notice.js';
import {
	echoedClientMessageIds,
	messagesFromDisplayRows,
	responseMessageTypesAfter,
	transcriptDisplayRows,
	visibleTranscriptRows,
	type ChatDisplayRow,
	type ChatTranscriptRow,
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
type SnapshotBatch = Pick<TranscriptAppend, 'firstOrdinal' | 'lastOrdinal' | 'messages'> & {
	transcriptViewId: string;
	noticeRevision: number;
	resendCandidates: ResendCandidate[];
};
export type MessageApplyResult = 'applied' | 'view-changed' | 'gap-detected';
type PageApplyResult = MessageApplyResult | 'stale';

export type ChatLoadStatus = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';

export class ActiveTranscriptState implements ActiveTranscriptPort {
	readonly transcriptCache: ChatTranscriptCache;
	activeChatId = $state<string | null>(null);
	entries = $state<TranscriptMessage[]>([]);
	#resendCandidates = $state<ResendCandidate[]>([]);
	#excludedResendOrdinals = $state<number[]>([]);
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
	#snapshotBuffer: SnapshotBatch[] | null = null;
	#loadEpoch = 0;
	#notices = new TranscriptNoticeFeed();
	#optimisticInputs = new TranscriptOptimisticInputs(() => {
		this.#growExpandedVisibleWindow();
		this.#recordFeedMutation('presentation-structure');
	});
	#pageLoadPromise: Promise<TranscriptPageLoadResult> | null = null;
	#loadingPageChatId: string | null = null;
	#loadingPageDirection: TranscriptPageDirection | null = null;
	#pageLoadOperationEpoch = 0;
	#windowNavigationEpoch = 0;
	#preserveExpandedVisibleWindow = false;
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
		const excluded = new Set(this.#excludedResendOrdinals);
		return this.#resendCandidates.filter((candidate) => !excluded.has(candidate.ordinal));
	}

	get excludedResendOrdinals(): readonly number[] {
		return this.#excludedResendOrdinals;
	}

	setResendCandidates(candidates: readonly ResendCandidate[]): void {
		this.#resendCandidates = candidates.map((candidate) => ({
			...candidate,
			attachmentNames: [...candidate.attachmentNames],
		}));
		const available = new Set(candidates.map((candidate) => candidate.ordinal));
		this.#excludedResendOrdinals = this.#excludedResendOrdinals.filter((ordinal) =>
			available.has(ordinal),
		);
	}

	excludeResendCandidate(ordinal: number): void {
		if (!this.#resendCandidates.some((candidate) => candidate.ordinal === ordinal)) return;
		if (this.#excludedResendOrdinals.includes(ordinal)) return;
		this.#excludedResendOrdinals = [...this.#excludedResendOrdinals, ordinal].sort(
			(left, right) => left - right,
		);
	}

	clearResendExclusions(): void {
		this.#excludedResendOrdinals = [];
	}

	#echoedClientMessageIds = $derived(echoedClientMessageIds(this.entries));

	#displayLocalNotices = $derived(
		displayLocalNotices(this.hasLaterMessages, this.historyState, this.localNotices),
	);

	#displayRows = $derived(transcriptDisplayRows({
		entries: this.entries,
		transcriptViewId: this.transcriptViewId,
		optimisticInputs: this.visibleOptimisticInputs,
		notices: this.#displayLocalNotices,
	}));

	#visibleRows = $derived(visibleTranscriptRows({
		entries: this.entries,
		transcriptViewId: this.transcriptViewId,
		optimisticInputs: this.visibleOptimisticInputs,
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
		const firstVisibleSeq = this.#visibleRows.find(
			(row): row is ChatTranscriptRow => row.kind === 'message' && row.ordinal !== undefined,
		)?.ordinal;
		return (
			firstVisibleSeq !== undefined && (this.entries[0]?.ordinal ?? firstVisibleSeq) < firstVisibleSeq
		);
	}

	get canLoadEarlier(): boolean {
		return this.hasEarlierRowsToReveal || this.hasEarlierMessages;
	}

	get canAutoFillEarlier(): boolean {
		return (
			this.hasEarlierRowsToReveal ||
			(this.hasEarlierMessages &&
				this.entries.length + MESSAGES_PER_PAGE <= ACTIVE_TRANSCRIPT_RETENTION_LIMIT)
		);
	}

	get canLoadLater(): boolean {
		return this.hasLaterMessages;
	}

	get visibleOptimisticInputs(): OptimisticUserInput[] {
		if (this.hasLaterMessages) return [];
		return this.optimisticUserInputs.filter(
			(input) => !this.#echoedClientMessageIds.has(input.clientMessageId),
		);
	}

	getCursor(): ChatCursor {
		return { transcriptViewId: this.transcriptViewId, lastOrdinal: this.lastOrdinal };
	}

	applyMessages(
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		firstOrdinal: number,
		lastOrdinal: number,
		resendCandidates: ResendCandidate[] = [...this.#resendCandidates],
		noticeRevision = this.#notices.revision,
	): MessageApplyResult {
		if (this.historyState.kind !== 'complete') {
			this.transcriptCache.markStale(chatId);
			return 'gap-detected';
		}
		const previousLastOrdinal = this.lastOrdinal;
		this.#optimisticInputs.clearMany(echoedClientMessageIds(messages));
		const append = { firstOrdinal, lastOrdinal, messages };
		if (this.#snapshotBuffer) {
			this.transcriptCache.applyMessages(chatId, transcriptViewId, append);
			this.#snapshotBuffer.push({
				transcriptViewId,
				...append,
				noticeRevision,
				resendCandidates,
			});
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
				this.#recordFeedMutation('live-append', responseMessageTypes);
			}
			this.setResendCandidates(resendCandidates);
			return 'applied';
		}
		const applied = applyTranscriptAppend(this.entries, append, this.lastOrdinal);
		let entriesChanged = applied.status === 'applied' && applied.changed;
		if (applied.status === 'applied') {
			const exceedsRetentionLimit = applied.messages.length > ACTIVE_TRANSCRIPT_RETENTION_LIMIT;
			const detachedFromLatest = exceedsRetentionLimit && this.isUserScrolledUp;
			const nextEntries = exceedsRetentionLimit
				? this.isUserScrolledUp
					? applied.messages.slice(0, ACTIVE_TRANSCRIPT_RETENTION_LIMIT)
					: applied.messages.slice(-ACTIVE_TRANSCRIPT_RETENTION_LIMIT)
				: applied.messages;
			this.transcriptViewId = transcriptViewId;
			if (nextEntries !== this.entries) this.entries = nextEntries;
			this.lastOrdinal = applied.lastOrdinal;
			if (!detachedFromLatest) this.loadedThroughOrdinal = applied.lastOrdinal;
			this.oldestOrdinal = this.entries[0]?.ordinal ?? 0;
			if (detachedFromLatest) {
				this.hasLaterMessages = true;
			} else if (exceedsRetentionLimit) {
				this.hasEarlierMessages = true;
			}
			this.visibleMessageCount = Math.min(
				this.visibleMessageCount,
				ACTIVE_TRANSCRIPT_RETENTION_LIMIT,
			);
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
		if (entriesChanged && this.#preserveExpandedVisibleWindow) {
			this.visibleMessageCount = Math.max(this.visibleMessageCount, this.displayMessageCount);
		}
		if (this.entries.length > 0 && this.loadStatus !== 'error') {
			this.loadStatus = 'loaded';
		}
		if (entriesChanged) {
			this.#recordFeedMutation('live-append', responseMessageTypes);
		}
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
		this.#preserveExpandedVisibleWindow = false;
		this.historyState = { kind: 'complete' };
		this.activeChatId = chatId;
		this.#loadEpoch += 1;
		this.#snapshotBuffer = null;
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
		this.#recordFeedMutation('replacement');
	}

	setFromPage(
		chatId: string,
		page: {
			transcriptViewId: string;
			messages: TranscriptMessage[];
			lastOrdinal: number;
			pageOldestOrdinal: number;
			pageNewestOrdinal: number;
			hasMore: boolean;
			resendCandidates?: ResendCandidate[];
		},
		epoch: number,
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

		this.#invalidatePageLoad();
		this.historyState = { kind: 'complete' };
		this.transcriptCache.replaceFromPage(chatId, page);
		this.windowRevision += 1;
		if (page.transcriptViewId !== this.transcriptViewId) {
			this.#preserveExpandedVisibleWindow = false;
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
		this.setResendCandidates(page.resendCandidates ?? []);
		this.clearLocalNotices(this.#notices.revisionAtLoadStart);
		this.loadStatus = page.messages.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		this.#recordFeedMutation('replacement');
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
				{ chatId, limit: MESSAGES_PER_PAGE, beforeOrdinal },
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
		if (page.messages.length === 0) {
			if (page.hasMore)
				throw new Error('Earlier transcript page did not advance the loaded window');
			this.hasEarlierMessages = false;
			return 'exhausted';
		}
		const addedMessages = collectEarlierTranscriptMessages(this.oldestOrdinal, page.messages);
		if (addedMessages.length === 0) {
			if (page.hasMore)
				throw new Error('Earlier transcript page did not advance the loaded window');
			this.hasEarlierMessages = false;
			return 'exhausted';
		}
		const mergedEntries = [...addedMessages, ...this.entries];
		const trimmedLater = mergedEntries.length > ACTIVE_TRANSCRIPT_RETENTION_LIMIT;
		this.entries = retainTranscriptEntries(mergedEntries, 'earlier');
		this.oldestOrdinal = addedMessages[0].ordinal;
		this.lastOrdinal = Math.max(this.lastOrdinal, page.lastOrdinal);
		this.hasEarlierMessages = page.hasMore;
		if (trimmedLater) {
			this.loadedThroughOrdinal = this.entries.at(-1)?.ordinal ?? 0;
			this.hasLaterMessages = true;
		}
		this.totalMessages = this.entries.length;
		this.visibleMessageCount = Math.min(
			this.visibleMessageCount + addedMessages.length,
			ACTIVE_TRANSCRIPT_RETENTION_LIMIT,
		);
		this.#rememberExpandedVisibleWindow();
		this.#recordFeedMutation('history-earlier');
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
		const trimmedEarlier = merged.length > ACTIVE_TRANSCRIPT_RETENTION_LIMIT;
		this.entries = retainTranscriptEntries(merged, 'later');
		this.lastOrdinal = Math.max(this.lastOrdinal, page.lastOrdinal);
		this.loadedThroughOrdinal = page.pageNewestOrdinal;
		this.oldestOrdinal = this.entries[0]?.ordinal ?? 0;
		if (trimmedEarlier) this.hasEarlierMessages = true;
		this.hasLaterMessages = !reachesLatest;
		this.totalMessages = this.entries.length;
		this.visibleMessageCount = Math.min(
			this.visibleMessageCount + addedMessages.length,
			ACTIVE_TRANSCRIPT_RETENTION_LIMIT,
		);
		this.#rememberExpandedVisibleWindow();
		this.#recordFeedMutation('history-later');
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
		this.#recordFeedMutation('presentation-structure');
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
		this.#recordFeedMutation('presentation-structure');
	}

	clearLocalNotices(throughRevision?: number): void {
		if (!this.#notices.clearThrough(throughRevision)) return;
		this.#recordFeedMutation('presentation-structure');
	}

	upsertOptimisticUserInput(input: OptimisticUserInput): void {
		this.clearLocalNotices();
		if (this.#echoedClientMessageIds.has(input.clientMessageId)) return;
		this.#optimisticInputs.upsert(input);
	}

	clearOptimisticUserInput(clientMessageId: string): void {
		this.#optimisticInputs.clear(clientMessageId);
	}

	clearMessages(): void {
		this.#resetToEmptyTranscript();
		this.loadStatus = 'idle';
		this.historyState = { kind: 'complete' };
		this.#recordFeedMutation('replacement');
	}

	#resetToEmptyTranscript(): void {
		this.#invalidatePageLoad();
		this.#preserveExpandedVisibleWindow = false;
		this.#loadEpoch += 1;
		this.windowRevision += 1;
		this.entries = [];
		this.transcriptViewId = '';
		this.lastOrdinal = 0;
		this.oldestOrdinal = 0;
		this.loadedThroughOrdinal = 0;
		this.#optimisticInputs.clearAll();
		this.#resendCandidates = [];
		this.#excludedResendOrdinals = [];
		this.#notices.reset();
		this.hasEarlierMessages = false;
		this.hasLaterMessages = false;
		this.totalMessages = 0;
		this.loadError = null;
		this.isLoadingMessages = false;
		this.#snapshotBuffer = null;
	}

	compactToRecentMessages(): boolean {
		if (this.entries.length <= ACTIVE_TRANSCRIPT_RETENTION_LIMIT) return false;
		this.entries = this.entries.slice(-ACTIVE_TRANSCRIPT_RETENTION_LIMIT);
		this.oldestOrdinal = this.entries[0]?.ordinal ?? 0;
		this.totalMessages = this.entries.length;
		this.hasEarlierMessages = true;
		this.visibleMessageCount = Math.min(this.visibleMessageCount, INITIAL_VISIBLE_MESSAGES);
		this.#preserveExpandedVisibleWindow = false;
		this.#recordFeedMutation('history-pruned');
		return true;
	}

	revealEarlierLoadedRows(): boolean {
		const previousCount = this.visibleMessageCount;
		this.visibleMessageCount = Math.min(this.displayMessageCount, previousCount + 100);
		const changed = this.visibleMessageCount > previousCount;
		if (changed) {
			this.pageStates.earlier = idlePageState();
			this.#rememberExpandedVisibleWindow();
			this.#recordFeedMutation('history-earlier');
		}
		return changed;
	}

	revealAllLoadedMessages(): void {
		const changed = this.visibleMessageCount < this.displayMessageCount;
		this.visibleMessageCount = Math.max(this.visibleMessageCount, this.displayMessageCount);
		this.#rememberExpandedVisibleWindow();
		if (changed) this.#recordFeedMutation('initial');
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
						}
					: { chatId, limit: MESSAGES_PER_PAGE },
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
							}
						: page;
				return this.setFromPage(chatId, latestPage, loadEpoch) === 'applied'
					? 'loaded'
					: 'invalidated';
			}

			this.#preserveExpandedVisibleWindow = false;
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
			this.#recordFeedMutation('replacement');
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
		this.#recordFeedMutation('replacement');
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

	#recordFeedMutation(
		kind: ConversationFeedMutationKind,
		responseMessageTypes: readonly string[] = [],
	): void {
		this.#feedMutations.record(kind, responseMessageTypes);
	}

	#rememberExpandedVisibleWindow(): void {
		if (
			this.entries.length > INITIAL_VISIBLE_MESSAGES &&
			this.visibleMessageCount >= this.entries.length
		) {
			this.#preserveExpandedVisibleWindow = true;
			this.#growExpandedVisibleWindow();
		}
	}

	#growExpandedVisibleWindow(): void {
		if (!this.#preserveExpandedVisibleWindow) return;
		this.visibleMessageCount = Math.max(this.visibleMessageCount, this.displayMessageCount);
	}
}
