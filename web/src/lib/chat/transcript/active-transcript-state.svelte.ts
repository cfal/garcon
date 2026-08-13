import {
	applyChatViewMessages,
	isDegradedChatHistoryResponse,
	type ChatHistoryState,
	type ChatViewMessage,
	type ChatViewPage,
} from '$shared/chat-view';
import { UserMessage, type ChatMessage, type UserMessageDeliveryStatus } from '$shared/chat-types';
import type { PendingUserInput } from '$shared/pending-user-input';
import { ChatTranscriptCache } from './chat-transcript-cache.svelte';
import { getChatMessages } from '$lib/api/chats.js';
import type { LocalNoticeRow, LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import { createRandomId } from '$lib/utils/random-id';
import { ConversationFeedMutationState } from './ConversationFeedMutationState.svelte.js';
import {
	responseMessageType,
	type ConversationFeedMutationKind,
} from './conversation-feed-mutations.js';
import type {
	ActiveTranscriptPort,
	ChatCursor,
	ChatLoadMessagesOptions,
	ChatRestoreResult,
} from './active-transcript-port.js';
import { validateRequestedTranscriptPage } from './transcript-page-progress.js';
import {
	retainLoadedTranscriptPrefix,
	stageLatestTranscriptWindow,
} from './transcript-window-loader.js';
import { displayLocalNotices } from './degraded-history-notice.js';
import {
	applyPendingDeliveryStatuses,
	mergeRowsWithPendingInputs,
	normalizePendingInputs,
	sortPendingInputs,
	type ChatTranscriptRow,
} from './transcript-row-projection.js';
export type {
	ActiveTranscriptPort,
	ChatCursor,
	ChatLoadMessagesOptions,
	ChatRestoreResult,
} from './active-transcript-port.js';
export type { ChatTranscriptRow } from './transcript-row-projection.js';

const MESSAGES_PER_PAGE = 50;
export const INITIAL_VISIBLE_MESSAGES = 100;
type ChatHistoryPage = Awaited<ReturnType<typeof getChatMessages>>;
type ChatPage = Extract<ChatHistoryPage, { historyState: { kind: 'complete' } }>;
type SnapshotBatch = { generationId: string; messages: ChatViewMessage[]; noticeRevision: number };
export type MessageApplyResult = 'applied' | 'generation-changed' | 'gap-detected';
type PageApplyResult = MessageApplyResult | 'stale';

export type ChatLoadStatus = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';
export type TranscriptPageLoadResult = 'loaded' | 'exhausted' | 'invalidated' | 'failed';
export type TranscriptPageDirection = 'earlier' | 'later';
export type TranscriptPageStatus = 'idle' | 'loading' | 'error';
export type TranscriptWindowLoadResult = 'loaded' | 'invalidated' | 'failed';
export type TranscriptWindowTarget = 'initial' | 'latest';

export interface TranscriptPageState {
	status: TranscriptPageStatus;
	error: string | null;
}

const idlePageState = (): TranscriptPageState => ({ status: 'idle', error: null });

export type ChatDisplayRow = ChatTranscriptRow | LocalNoticeRow;

export class ActiveTranscriptState implements ActiveTranscriptPort {
	readonly transcriptCache: ChatTranscriptCache;
	activeChatId = $state<string | null>(null);
	entries = $state<ChatViewMessage[]>([]);
	generationId = $state('');
	windowRevision = $state(0);
	lastSeq = $state(0);
	oldestSeq = $state(0);
	pendingUserInputs = $state<PendingUserInput[]>([]);
	localNotices = $state<(LocalNoticeRow & { revision: number })[]>([]);
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
	#localNoticeRevision = 0;
	#localNoticeRevisionAtLoadStart = 0;
	#pendingUserInputsRevision = 0;
	#pendingUserInputsRevisionAtLoadStart = 0;
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

	#renderEntries = $derived.by(() =>
		applyPendingDeliveryStatuses(this.entries, this.pendingUserInputs),
	);

	#echoedClientRequestIds = $derived.by(() => {
		const ids = new Set<string>();
		for (const entry of this.#renderEntries) {
			const message = entry.message;
			if (message instanceof UserMessage && message.metadata?.clientRequestId) {
				ids.add(message.metadata.clientRequestId);
			}
		}
		return ids;
	});

	#displayLocalNotices = $derived(
		displayLocalNotices(this.hasLaterMessages, this.historyState, this.localNotices),
	);

	#displayRows = $derived.by(() => {
		const durableRows = this.#renderEntries.map((entry) => ({
			kind: 'message' as const,
			id: `${this.generationId}:${entry.seq}`,
			seq: entry.seq,
			message: entry.message,
		}));
		const merged =
			this.visiblePendingInputs.length === 0
				? durableRows
				: mergeRowsWithPendingInputs(durableRows, this.visiblePendingInputs);
		if (this.#displayLocalNotices.length === 0) return merged;
		return [...merged, ...this.#displayLocalNotices];
	});

	#displayMessages = $derived.by(() =>
		this.#displayRows.flatMap((row) => (row.kind === 'message' ? [row.message] : [])),
	);

	#displayMessageCount = $derived.by(
		() =>
			this.#renderEntries.length +
			this.visiblePendingInputs.length +
			this.#displayLocalNotices.length,
	);

	#visibleRows = $derived.by(() => {
		const noticeCount = Math.min(this.#displayLocalNotices.length, this.visibleMessageCount);
		const visibleNotices = this.#displayLocalNotices.slice(-noticeCount);
		const messageLimit = this.visibleMessageCount - noticeCount;
		if (messageLimit === 0) return visibleNotices;

		const durableRows = this.#renderEntries.slice(-messageLimit).map((entry) => ({
			kind: 'message' as const,
			id: `${this.generationId}:${entry.seq}`,
			seq: entry.seq,
			message: entry.message,
		}));
		const pendingInputs = this.visiblePendingInputs;
		const messageRows =
			pendingInputs.length === 0
				? durableRows
				: mergeRowsWithPendingInputs(durableRows, pendingInputs).slice(-messageLimit);
		return [...messageRows, ...visibleNotices];
	});

	#visibleMessages = $derived.by(() =>
		this.#visibleRows.flatMap((row) => (row.kind === 'message' ? [row.message] : [])),
	);

	get chatMessages(): ChatMessage[] {
		return this.#renderEntries.map((entry) => entry.message);
	}

	get feedMutationClock() {
		return this.#feedMutations.clock;
	}

	get displayMessages(): ChatMessage[] {
		return this.#displayMessages;
	}

	get displayRows(): readonly ChatDisplayRow[] {
		return this.#displayRows;
	}

	get visibleRows(): ChatDisplayRow[] {
		return this.#visibleRows;
	}

	get displayMessageCount(): number {
		return this.#displayMessageCount;
	}

	get visibleMessages(): ChatMessage[] {
		return this.#visibleMessages;
	}

	get newestLoadedSeq(): number {
		return this.entries.at(-1)?.seq ?? 0;
	}

	get hasLaterMessages(): boolean {
		return this.newestLoadedSeq > 0 && this.newestLoadedSeq < this.lastSeq;
	}

	get hasEarlierRowsToReveal(): boolean {
		const firstVisibleSeq = this.#visibleRows.find(
			(row): row is ChatTranscriptRow => row.kind === 'message' && row.seq !== undefined,
		)?.seq;
		return (
			firstVisibleSeq !== undefined && (this.entries[0]?.seq ?? firstVisibleSeq) < firstVisibleSeq
		);
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

	get visiblePendingInputs(): PendingUserInput[] {
		if (this.hasLaterMessages) return [];
		return this.pendingUserInputs.filter(
			(input) => !this.#echoedClientRequestIds.has(input.clientRequestId),
		);
	}

	getCursor(): ChatCursor {
		return { generationId: this.generationId, lastSeq: this.lastSeq };
	}

	applyMessages(
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
		noticeRevision = this.#localNoticeRevision,
	): MessageApplyResult {
		if (this.historyState.kind === 'degraded') {
			this.transcriptCache.markStale(chatId);
			return 'gap-detected';
		}
		const previousLastSeq = this.lastSeq;
		if (this.#snapshotBuffer) {
			this.transcriptCache.applyMessages(chatId, generationId, messages);
			this.#snapshotBuffer.push({ generationId, messages, noticeRevision });
			return 'applied';
		}
		if (this.generationId && generationId !== this.generationId) {
			this.#invalidatePageLoad();
			this.transcriptCache.markStale(chatId);
			return 'generation-changed';
		}
		const result = this.transcriptCache.applyMessages(chatId, generationId, messages);
		if (result.status === 'generation-changed') {
			this.#invalidatePageLoad();
			this.transcriptCache.markStale(chatId);
			return 'generation-changed';
		}
		if (result.status !== 'applied') {
			const gapDetails =
				result.status === 'gap-detected'
					? ` expected=${result.expectedSeq} received=${result.receivedSeq}`
					: '';
			console.warn(
				`[chat-state] transcript apply failed chat=${chatId} generation=${generationId} status=${result.status}${gapDetails}`,
			);
			return 'gap-detected';
		}
		const responseMessageTypes = messages.flatMap((entry) => {
			if (entry.seq <= previousLastSeq) return [];
			const type = responseMessageType(entry.message);
			return type ? [type] : [];
		});
		const cursorAdvanced = result.lastSeq > previousLastSeq;
		if (this.hasLaterMessages) {
			this.generationId = generationId;
			this.lastSeq = result.lastSeq;
			if (result.changed || cursorAdvanced) {
				this.clearLocalNotices(noticeRevision);
			}
			if (this.entries.length > 0 && this.loadStatus !== 'error') {
				this.loadStatus = 'loaded';
			}
			if (result.changed || cursorAdvanced) {
				this.#recordFeedMutation('live-append', responseMessageTypes);
			}
			return 'applied';
		}
		const previousEntryCount = this.entries.length;
		const applied = applyChatViewMessages(this.entries, messages, this.lastSeq);
		let entriesChanged = applied.status === 'applied' && applied.changed;
		const appendedEntryCount =
			applied.status === 'applied' ? applied.messages.length - previousEntryCount : 0;
		if (applied.status === 'applied') {
			this.generationId = generationId;
			if (applied.messages !== this.entries) this.entries = applied.messages;
			this.lastSeq = applied.lastSeq;
			this.oldestSeq = this.entries[0]?.seq ?? 0;
		} else {
			const restored = this.transcriptCache.get(chatId);
			if (!restored || restored.generationId !== generationId) return 'gap-detected';
			this.#invalidatePageLoad();
			entriesChanged = true;
			this.generationId = restored.generationId;
			this.entries = restored.messages;
			this.lastSeq = restored.lastSeq;
			this.oldestSeq = this.entries[0]?.seq ?? 0;
		}
		if (entriesChanged) {
			this.clearLocalNotices(noticeRevision);
		}
		this.totalMessages = this.entries.length;
		if (entriesChanged && this.#preserveExpandedVisibleWindow) {
			this.visibleMessageCount = Math.max(this.visibleMessageCount, this.displayMessageCount);
		} else if (entriesChanged && this.isUserScrolledUp && appendedEntryCount > 0) {
			this.visibleMessageCount = Math.min(
				this.displayMessageCount,
				this.visibleMessageCount + appendedEntryCount,
			);
		}
		if (this.entries.length > 0 && this.loadStatus !== 'error') {
			this.loadStatus = 'loaded';
		}
		if (entriesChanged) {
			this.#recordFeedMutation('live-append', responseMessageTypes);
		}
		return 'applied';
	}

	beginSnapshotLoad(): number {
		const epoch = this.#beginLoadEpoch();
		this.#invalidatePageLoad();
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
		for (const { generationId, messages, noticeRevision } of buffered) {
			if (this.applyMessages(chatId, generationId, messages, noticeRevision) !== 'applied') break;
		}
		return true;
	}

	replaceGeneration(
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
		options: Pick<ChatViewPage, 'lastSeq' | 'pageOldestSeq' | 'hasMore'> & {
			pendingUserInputs?: PendingUserInput[];
		},
	): void {
		this.#invalidatePageLoad();
		this.#preserveExpandedVisibleWindow = false;
		this.historyState = { kind: 'complete' };
		this.activeChatId = chatId;
		this.#loadEpoch += 1;
		this.#snapshotBuffer = null;
		this.transcriptCache.replaceFromPage(chatId, {
			generationId,
			messages,
			lastSeq: options.lastSeq,
			pageOldestSeq: options.pageOldestSeq,
			hasMore: options.hasMore,
		});
		this.windowRevision += 1;
		this.generationId = generationId;
		this.entries = messages;
		this.lastSeq = options.lastSeq;
		this.oldestSeq = messages[0]?.seq ?? 0;
		this.hasEarlierMessages = options.hasMore;
		this.totalMessages = messages.length;
		this.#replacePendingUserInputs(options.pendingUserInputs ?? []);
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.localNotices = [];
		this.loadStatus = messages.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		this.#recordFeedMutation('replacement');
	}

	setFromPage(
		chatId: string,
		page: {
			generationId: string;
			messages: ChatViewMessage[];
			lastSeq: number;
			pageOldestSeq: number;
			hasMore: boolean;
			pendingUserInputs: PendingUserInput[];
		},
		epoch: number,
	): PageApplyResult {
		if (epoch !== this.#loadEpoch) return 'stale';
		const stagedPage = retainLoadedTranscriptPrefix(this.generationId, this.entries, page);

		const buffered = this.#snapshotBuffer ?? [];
		const hasBufferedGenerationChange = buffered.some(
			(batch) => batch.generationId !== stagedPage.generationId,
		);
		if (hasBufferedGenerationChange) {
			this.#invalidatePageLoad();
			this.isLoadingMessages = false;
			return 'generation-changed';
		}
		let validatedMessages = stagedPage.messages;
		let validatedLastSeq = stagedPage.lastSeq;
		for (const batch of buffered) {
			const validation = applyChatViewMessages(validatedMessages, batch.messages, validatedLastSeq);
			if (validation.status !== 'applied') return 'gap-detected';
			validatedMessages = validation.messages;
			validatedLastSeq = validation.lastSeq;
		}
		this.#snapshotBuffer = null;
		if (stagedPage.generationId !== this.generationId) {
			const preservesExpandedWindow =
				this.#preserveExpandedVisibleWindow &&
				stagedPage.messages.length >= this.visibleMessageCount;
			this.#preserveExpandedVisibleWindow = preservesExpandedWindow;
			if (!preservesExpandedWindow) this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		}

		this.#invalidatePageLoad();
		this.historyState = { kind: 'complete' };
		this.transcriptCache.replaceFromPage(chatId, stagedPage);
		this.windowRevision += 1;
		this.generationId = stagedPage.generationId;
		this.entries = stagedPage.messages;
		this.lastSeq = stagedPage.lastSeq;
		this.oldestSeq = stagedPage.messages[0]?.seq ?? 0;
		this.hasEarlierMessages = stagedPage.hasMore;
		this.totalMessages = stagedPage.messages.length;
		if (this.#pendingUserInputsRevision === this.#pendingUserInputsRevisionAtLoadStart) {
			this.#replacePendingUserInputs(normalizePendingInputs(stagedPage.pendingUserInputs));
		}
		this.clearLocalNotices(this.#localNoticeRevisionAtLoadStart);
		this.loadStatus = stagedPage.messages.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		this.#recordFeedMutation('replacement');
		for (const { generationId, messages, noticeRevision } of buffered) {
			const result = this.applyMessages(chatId, generationId, messages, noticeRevision);
			if (result !== 'applied') return result;
		}
		return 'applied';
	}

	async loadMessages(
		chatId: string,
		options: ChatLoadMessagesOptions = {},
	): Promise<ChatMessage[]> {
		if (!chatId) return [];
		const requestedMinimum = Number.isFinite(options.minimumLimit)
			? Math.max(0, Math.floor(options.minimumLimit ?? 0))
			: 0;
		const minimumMessageCount = Math.max(
			MESSAGES_PER_PAGE,
			requestedMinimum,
			this.activeChatId === chatId ? this.entries.length : 0,
		);
		const maxAttempts = 2;

		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const epoch = this.beginSnapshotLoad();
			try {
				const page = await stageLatestTranscriptWindow(chatId, minimumMessageCount);
				if (this.activeChatId && this.activeChatId !== chatId) {
					this.abortSnapshotLoad(epoch);
					return this.chatMessages;
				}
				if (isDegradedChatHistoryResponse(page)) {
					if (epoch !== this.#loadEpoch) return this.chatMessages;
					this.#setDegradedHistory(chatId, page.historyState);
					return [];
				}
				const result = this.setFromPage(chatId, page, epoch);

				if (result === 'applied') return this.chatMessages;
				if (result === 'stale') return this.chatMessages;

				if (result !== 'gap-detected') this.abortSnapshotLoad(epoch);
			} catch (error) {
				if (this.#finishFailedSnapshotLoad(chatId, epoch)) {
					this.loadStatus = 'error';
					this.loadError = error instanceof Error ? error.message : 'Failed to load messages';
				}
				throw error;
			}
		}

		this.#finishFailedSnapshotLoad(chatId, this.#loadEpoch);
		this.loadStatus = 'error';
		this.loadError = 'Chat changed while loading messages';
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

		const generationId = this.generationId;
		const operationEpoch = this.#pageLoadOperationEpoch;
		const newestSeq = this.newestLoadedSeq;
		const retryError =
			this.pageStates[direction].status === 'error' ? this.pageStates[direction].error : null;
		this.pageStates[direction] = { status: 'loading', error: retryError };
		const loadPromise = this.#performPageLoad(
			direction,
			chatId,
			generationId,
			operationEpoch,
			newestSeq,
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
		generationId: string,
		operationEpoch: number,
		newestSeq: number,
	): Promise<TranscriptPageLoadResult> {
		try {
			const request =
				direction === 'earlier'
					? { chatId, limit: MESSAGES_PER_PAGE, beforeSeq: this.oldestSeq }
					: {
							chatId,
							limit: MESSAGES_PER_PAGE,
							beforeSeq: Math.min(newestSeq + MESSAGES_PER_PAGE + 1, this.lastSeq + 1),
						};
			const page = await getChatMessages(request);
			if (!this.#isCurrentPageLoad(chatId, generationId, operationEpoch)) {
				return 'invalidated';
			}
			if (page.chatId !== chatId) {
				throw new Error('Transcript page belongs to another chat');
			}
			if (isDegradedChatHistoryResponse(page)) {
				this.#setDegradedHistory(chatId, page.historyState);
				return 'invalidated';
			}
			if (page.generationId !== generationId) {
				await this.loadMessages(chatId);
				return 'invalidated';
			}
			if (!validateRequestedTranscriptPage(request, page)) {
				throw new Error('Transcript page did not match the requested window');
			}
			return direction === 'earlier'
				? this.#applyEarlierPage(chatId, page)
				: this.#applyLaterPage(page, newestSeq);
		} catch (error) {
			if (this.#isCurrentPageLoad(chatId, generationId, operationEpoch)) {
				this.pageStates[direction] = {
					status: 'error',
					error: error instanceof Error ? error.message : 'Page load failed',
				};
			}
			console.error(`Error loading ${direction} messages:`, error);
			return 'failed';
		}
	}

	#applyEarlierPage(chatId: string, page: ChatPage): TranscriptPageLoadResult {
		if (page.messages.length === 0) {
			if (page.hasMore)
				throw new Error('Earlier transcript page did not advance the loaded window');
			this.hasEarlierMessages = false;
			return 'exhausted';
		}
		const mergedEntries = [...page.messages, ...this.entries];
		this.entries = mergedEntries;
		this.oldestSeq = page.pageOldestSeq;
		this.lastSeq = Math.max(this.lastSeq, page.lastSeq);
		this.hasEarlierMessages = page.hasMore;
		this.totalMessages = this.entries.length;
		this.visibleMessageCount = Math.min(
			this.displayMessageCount,
			this.visibleMessageCount + page.messages.length,
		);
		if (!this.hasLaterMessages) {
			this.transcriptCache.replaceFromPage(chatId, {
				generationId: this.generationId,
				messages: this.entries,
				lastSeq: this.lastSeq,
				pageOldestSeq: this.oldestSeq,
				hasMore: this.hasEarlierMessages,
			});
		}
		this.#rememberExpandedVisibleWindow();
		this.#recordFeedMutation('history-earlier');
		return 'loaded';
	}

	#applyLaterPage(page: ChatPage, newestSeq: number): TranscriptPageLoadResult {
		const previousEntryCount = this.entries.length;
		const applied = applyChatViewMessages(this.entries, page.messages, newestSeq);
		if (applied.status !== 'applied' || !applied.changed) {
			throw new Error('Later transcript page did not advance the loaded window');
		}

		const addedMessageCount = applied.messages.length - previousEntryCount;
		this.entries = applied.messages;
		this.lastSeq = Math.max(this.lastSeq, page.lastSeq);
		this.oldestSeq = this.entries[0]?.seq ?? 0;
		this.totalMessages = this.entries.length;
		this.visibleMessageCount = Math.min(
			this.displayMessageCount,
			this.visibleMessageCount + addedMessageCount,
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

	#isCurrentPageLoad(chatId: string, generationId: string, operationEpoch: number): boolean {
		return (
			this.#pageLoadOperationEpoch === operationEpoch &&
			this.activeChatId === chatId &&
			this.generationId === generationId
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
		this.localNotices = [
			...this.localNotices,
			{
				kind: 'local-notice',
				id: `local_${createRandomId()}`,
				noticeType,
				content,
				timestamp: new Date().toISOString(),
				revision: ++this.#localNoticeRevision,
			},
		];
		this.#growExpandedVisibleWindow();
		this.#recordFeedMutation('presentation-structure');
	}

	clearLocalNotices(throughRevision = this.#localNoticeRevision): void {
		const next = this.localNotices.filter((notice) => notice.revision > throughRevision);
		if (next.length === this.localNotices.length) return;
		this.localNotices = next;
		this.#recordFeedMutation('presentation-structure');
	}

	setPendingUserInputs(inputs: PendingUserInput[]): void {
		this.#replacePendingUserInputs(inputs);
	}

	upsertPendingUserInput(input: PendingUserInput): void {
		this.clearLocalNotices();
		const next = this.pendingUserInputs.slice();
		const index = next.findIndex((entry) => entry.clientRequestId === input.clientRequestId);
		if (index >= 0) next[index] = input;
		else next.push(input);
		this.#replacePendingUserInputs(next);
	}

	clearPendingUserInput(clientRequestId: string): void {
		const next = this.pendingUserInputs.filter(
			(input) => input.clientRequestId !== clientRequestId,
		);
		if (next.length === this.pendingUserInputs.length) return;
		this.#replacePendingUserInputs(next);
	}

	updatePendingUserInputDeliveryStatus(
		clientRequestId: string,
		deliveryStatus: UserMessageDeliveryStatus,
	): void {
		const current = this.pendingUserInputs.find(
			(input) => input.clientRequestId === clientRequestId,
		);
		if (!current || current.deliveryStatus === deliveryStatus) return;
		this.#replacePendingUserInputs(
			this.pendingUserInputs.map((input) =>
				input.clientRequestId === clientRequestId ? { ...input, deliveryStatus } : input,
			),
		);
	}

	#replacePendingUserInputs(inputs: PendingUserInput[]): void {
		this.#pendingUserInputsRevision += 1;
		this.pendingUserInputs = sortPendingInputs(inputs);
		this.#growExpandedVisibleWindow();
		this.#recordFeedMutation('presentation-structure');
	}

	clearMessages(): void {
		this.#invalidatePageLoad();
		this.#preserveExpandedVisibleWindow = false;
		this.#loadEpoch += 1;
		this.windowRevision += 1;
		this.entries = [];
		this.generationId = '';
		this.lastSeq = 0;
		this.oldestSeq = 0;
		this.#replacePendingUserInputs([]);
		this.localNotices = [];
		this.hasEarlierMessages = false;
		this.totalMessages = 0;
		this.loadStatus = 'idle';
		this.loadError = null;
		this.historyState = { kind: 'complete' };
		this.isLoadingMessages = false;
		this.#snapshotBuffer = null;
		this.#recordFeedMutation('replacement');
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
		const alreadyAtTarget =
			target === 'latest'
				? !this.hasLaterMessages
				: this.hasLaterMessages ||
					(this.oldestSeq === 1 &&
						this.entries.length <= MESSAGES_PER_PAGE &&
						this.entries.at(-1)?.seq === this.lastSeq);

		const windowNavigationEpoch = ++this.#windowNavigationEpoch;
		const loadEpoch = this.#beginLoadEpoch();
		this.#invalidatePageLoad();
		this.isLoadingMessages = false;
		if (alreadyAtTarget) return 'loaded';

		const generationId = this.generationId;
		const latestLastSeq = this.lastSeq;
		const request =
			target === 'initial'
				? {
						chatId,
						limit: MESSAGES_PER_PAGE,
						beforeSeq: Math.min(latestLastSeq + 1, MESSAGES_PER_PAGE + 1),
					}
				: { chatId, limit: MESSAGES_PER_PAGE };

		try {
			const page = await getChatMessages(request);
			if (
				windowNavigationEpoch !== this.#windowNavigationEpoch ||
				loadEpoch !== this.#loadEpoch ||
				this.activeChatId !== chatId ||
				this.generationId !== generationId
			) {
				return 'invalidated';
			}
			if (isDegradedChatHistoryResponse(page)) {
				this.#setDegradedHistory(chatId, page.historyState);
				return 'loaded';
			}
			if (page.chatId !== chatId) {
				throw new Error('Transcript page belongs to another chat');
			}
			if (page.generationId !== generationId) {
				this.transcriptCache.markStale(chatId);
				return 'invalidated';
			}
			if (!validateRequestedTranscriptPage(request, page)) {
				throw new Error('Transcript page did not match the requested window');
			}

			if (target === 'latest') {
				const cached = this.transcriptCache.get(chatId);
				const latestPage =
					cached &&
					!cached.stale &&
					cached.generationId === page.generationId &&
					cached.lastSeq > page.lastSeq
						? {
								...page,
								messages: cached.messages,
								lastSeq: cached.lastSeq,
								pageOldestSeq: cached.oldestSeq,
							}
						: page;
				return this.setFromPage(chatId, latestPage, loadEpoch) === 'applied'
					? 'loaded'
					: 'invalidated';
			}

			this.#preserveExpandedVisibleWindow = false;
			this.windowRevision += 1;
			this.entries = page.messages;
			this.oldestSeq = page.messages[0]?.seq ?? 0;
			this.hasEarlierMessages = false;
			this.totalMessages = page.messages.length;
			this.visibleMessageCount = page.messages.length;
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
				this.generationId !== generationId
			) {
				return 'invalidated';
			}
			console.error(`Error loading ${target} messages:`, error);
			return 'failed';
		}
	}

	#beginLoadEpoch(): number {
		this.#pendingUserInputsRevisionAtLoadStart = this.#pendingUserInputsRevision;
		this.#localNoticeRevisionAtLoadStart = this.#localNoticeRevision;
		return ++this.#loadEpoch;
	}

	resetForNewChat(): void {
		this.clearMessages();
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.isUserScrolledUp = false;
	}

	#setDegradedHistory(
		chatId: string,
		historyState: Extract<ChatHistoryState, { kind: 'degraded' }>,
	): void {
		this.#invalidatePageLoad();
		this.#preserveExpandedVisibleWindow = false;
		this.activeChatId = chatId;
		this.#loadEpoch += 1;
		this.#snapshotBuffer = null;
		this.transcriptCache.remove(chatId);
		this.windowRevision += 1;
		this.entries = [];
		this.generationId = '';
		this.lastSeq = 0;
		this.oldestSeq = 0;
		this.#replacePendingUserInputs([]);
		this.localNotices = [];
		this.hasEarlierMessages = false;
		this.totalMessages = 0;
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.loadStatus = 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		this.historyState = historyState;
		this.#recordFeedMutation('replacement');
	}

	activateChat(chatId: string | null): ChatRestoreResult | null {
		this.activeChatId = chatId;
		this.resetForNewChat();
		if (!chatId) return null;
		// Publishes the bounded cache window atomically; the virtual feed limits mounted row work.
		const restored = this.transcriptCache.get(chatId);
		if (!restored) return null;
		this.entries = restored.messages;
		this.generationId = restored.generationId;
		this.lastSeq = restored.lastSeq;
		this.oldestSeq = restored.messages[0]?.seq ?? 0;
		this.totalMessages = restored.messages.length;
		this.visibleMessageCount = Math.max(INITIAL_VISIBLE_MESSAGES, restored.messages.length);
		this.#preserveExpandedVisibleWindow = restored.messages.length > INITIAL_VISIBLE_MESSAGES;
		// Preserves the earlier boundary across cache restore so validation cannot insert it after paint.
		this.hasEarlierMessages = restored.oldestSeq > 1;
		this.loadStatus = restored.messages.length === 0 ? 'empty' : 'loaded';
		return { count: restored.messages.length, stale: restored.stale };
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
			this.#renderEntries.length > INITIAL_VISIBLE_MESSAGES &&
			this.visibleMessageCount >= this.#renderEntries.length
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
