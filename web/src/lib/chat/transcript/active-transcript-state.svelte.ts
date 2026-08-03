import { applyChatViewMessages, type ChatViewMessage, type ChatViewPage } from '$shared/chat-view';
import { UserMessage, type ChatMessage, type UserMessageDeliveryStatus } from '$shared/chat-types';
import { normalizePendingUserInput, type PendingUserInput } from '$shared/pending-user-input';
import { ChatTranscriptCache } from './chat-transcript-cache.svelte';
import { getChatMessages } from '$lib/api/chats.js';
import type { LocalNoticeRow, LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import { createRandomId } from '$lib/utils/random-id';
import { ConversationFeedMutationState } from './ConversationFeedMutationState.svelte.js';
import type { ConversationFeedMutationKind } from './conversation-feed-mutations.js';
import type {
	ActiveTranscriptPort,
	ChatCursor,
	ChatLoadMessagesOptions,
	ChatRestoreResult,
} from './active-transcript-port.js';
import { collectEarlierTranscriptMessages } from './transcript-page-progress.js';
export type {
	ActiveTranscriptPort,
	ChatCursor,
	ChatLoadMessagesOptions,
	ChatRestoreResult,
} from './active-transcript-port.js';

const MESSAGES_PER_PAGE = 50;
export const INITIAL_VISIBLE_MESSAGES = 100;
export const INITIAL_SWITCH_VISIBLE_MESSAGES = 20;
export const ACTIVE_TRANSCRIPT_RETENTION_LIMIT = 200;
const SWITCH_REVEAL_BATCH_SIZE = 20;
type ChatPage = Awaited<ReturnType<typeof getChatMessages>>;
type SnapshotBatch = { generationId: string; messages: ChatViewMessage[]; noticeRevision: number };
export type MessageApplyResult = 'applied' | 'generation-changed' | 'gap-detected';
type PageApplyResult = MessageApplyResult | 'stale';
type InitialRevealPhase = 'pending' | 'revealing' | 'complete';

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

function idlePageState(): TranscriptPageState {
	return { status: 'idle', error: null };
}

export interface ChatTranscriptRow {
	kind: 'message';
	id: string;
	message: ChatMessage;
	seq?: number;
}

export type ChatDisplayRow = ChatTranscriptRow | LocalNoticeRow;
function pendingInputsFromPage(page: Pick<ChatPage, 'pendingUserInputs'>): PendingUserInput[] {
	return sortPendingInputs(
		page.pendingUserInputs
			.map(normalizePendingUserInput)
			.filter((input): input is PendingUserInput => Boolean(input)),
	);
}

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
	#initialRevealPhase = $state<InitialRevealPhase>('complete');
	#feedMutations = new ConversationFeedMutationState();

	constructor(transcriptCache = new ChatTranscriptCache({ limit: INITIAL_VISIBLE_MESSAGES })) {
		this.transcriptCache = transcriptCache;
	}

	#renderEntries = $derived.by(() =>
		applyPendingDeliveryStatuses(
			uniqueEntriesByClientRequestId(this.entries),
			this.pendingUserInputs,
		),
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
		this.hasLaterMessages ? ([] as LocalNoticeRow[]) : this.localNotices,
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

	#bottomVisibleRowId = $derived.by(() => this.#visibleRows.at(-1)?.id ?? null);

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

	get bottomVisibleRowId(): string | null {
		return this.#bottomVisibleRowId;
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
		if (this.#initialRevealPhase !== 'complete') return false;
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
		return (
			this.hasEarlierRowsToReveal ||
			(this.hasEarlierMessages &&
				this.entries.length + MESSAGES_PER_PAGE <= ACTIVE_TRANSCRIPT_RETENTION_LIMIT)
		);
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
		if (this.hasLaterMessages) {
			this.generationId = generationId;
			this.lastSeq = result.lastSeq;
			if (result.changed) {
				this.clearLocalNotices(noticeRevision);
			}
			if (this.entries.length > 0 && this.loadStatus !== 'error') {
				this.loadStatus = 'loaded';
			}
			if (result.changed) this.#recordFeedMutation('live-append');
			return 'applied';
		}
		const applied = applyChatViewMessages(this.entries, messages, this.lastSeq);
		const visibleChanged = applied.status === 'applied' && applied.changed;
		if (applied.status === 'applied') {
			const shouldCompact =
				!this.isUserScrolledUp && this.visibleMessageCount <= INITIAL_VISIBLE_MESSAGES;
			const nextEntries =
				shouldCompact && applied.messages.length > ACTIVE_TRANSCRIPT_RETENTION_LIMIT
					? applied.messages.slice(-ACTIVE_TRANSCRIPT_RETENTION_LIMIT)
					: applied.messages;
			this.generationId = generationId;
			this.entries = nextEntries;
			this.lastSeq = applied.lastSeq;
			this.oldestSeq = this.entries[0]?.seq ?? 0;
			if (nextEntries.length < applied.messages.length) {
				this.hasEarlierMessages = true;
				this.visibleMessageCount = Math.min(this.visibleMessageCount, INITIAL_VISIBLE_MESSAGES);
			}
		} else {
			const restored = this.transcriptCache.get(chatId);
			if (!restored || restored.generationId !== generationId) return 'gap-detected';
			this.generationId = restored.generationId;
			this.entries = restored.messages;
			this.lastSeq = restored.lastSeq;
			this.oldestSeq = restored.oldestSeq;
		}
		if (result.changed || visibleChanged) {
			this.clearLocalNotices(noticeRevision);
		}
		this.totalMessages = this.entries.length;
		if (this.entries.length > 0 && this.loadStatus !== 'error') {
			this.loadStatus = 'loaded';
		}
		if (result.changed) this.#recordFeedMutation('live-append');
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
		this.oldestSeq = options.pageOldestSeq;
		this.hasEarlierMessages = options.hasMore;
		this.totalMessages = messages.length;
		this.#replacePendingUserInputs(options.pendingUserInputs ?? []);
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.#initialRevealPhase = 'complete';
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

		const buffered = this.#snapshotBuffer ?? [];
		this.#snapshotBuffer = null;
		const hasBufferedGenerationChange = buffered.some(
			(batch) => batch.generationId !== page.generationId,
		);
		if (hasBufferedGenerationChange) {
			this.#invalidatePageLoad();
			this.isLoadingMessages = false;
			return 'generation-changed';
		}

		this.#invalidatePageLoad();
		this.transcriptCache.replaceFromPage(chatId, page);
		this.windowRevision += 1;
		this.generationId = page.generationId;
		this.entries = page.messages;
		this.lastSeq = page.lastSeq;
		this.oldestSeq = page.pageOldestSeq;
		this.hasEarlierMessages = page.hasMore;
		this.totalMessages = page.messages.length;
		if (this.#pendingUserInputsRevision === this.#pendingUserInputsRevisionAtLoadStart) {
			this.#replacePendingUserInputs(pendingInputsFromPage(page));
		}
		this.clearLocalNotices(this.#localNoticeRevisionAtLoadStart);
		this.loadStatus = page.messages.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		this.#recordFeedMutation('replacement');
		for (const { generationId, messages, noticeRevision } of buffered) {
			const result = this.applyMessages(chatId, generationId, messages, noticeRevision);
			if (result !== 'applied') return result;
		}
		this.#resolvePendingInitialReveal();
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

		const generationId = this.generationId;
		const operationEpoch = this.#pageLoadOperationEpoch;
		const newestSeq = this.newestLoadedSeq;
		this.pageStates[direction] = { status: 'loading', error: null };
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
			const page = await getChatMessages(
				direction === 'earlier'
					? { chatId, limit: MESSAGES_PER_PAGE, beforeSeq: this.oldestSeq }
					: {
							chatId,
							limit: MESSAGES_PER_PAGE,
							beforeSeq: Math.min(newestSeq + MESSAGES_PER_PAGE + 1, this.lastSeq + 1),
						},
			);
			if (!this.#isCurrentPageLoad(chatId, generationId, operationEpoch)) {
				return 'invalidated';
			}
			if (page.generationId !== generationId) {
				await this.loadMessages(chatId);
				return 'invalidated';
			}
			return direction === 'earlier'
				? this.#applyEarlierPage(page)
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

	#applyEarlierPage(page: ChatPage): TranscriptPageLoadResult {
		if (page.messages.length === 0) {
			this.hasEarlierMessages = false;
			return 'exhausted';
		}
		const addedMessages = collectEarlierTranscriptMessages(this.oldestSeq, page.messages);
		if (addedMessages.length === 0) {
			if (page.hasMore)
				throw new Error('Earlier transcript page did not advance the loaded window');
			this.hasEarlierMessages = false;
			return 'exhausted';
		}
		this.entries = [...addedMessages, ...this.entries];
		this.oldestSeq = addedMessages[0].seq;
		this.lastSeq = Math.max(this.lastSeq, page.lastSeq);
		this.hasEarlierMessages = page.hasMore;
		this.totalMessages = this.entries.length;
		this.visibleMessageCount += addedMessages.length;
		this.#recordFeedMutation('history-earlier');
		return 'loaded';
	}

	#applyLaterPage(page: ChatPage, newestSeq: number): TranscriptPageLoadResult {
		const previousEntryCount = this.entries.length;
		const applied = applyChatViewMessages(this.entries, page.messages, newestSeq);
		if (applied.status !== 'applied' || !applied.changed) {
			throw new Error('Later transcript page did not advance the loaded window');
		}

		this.entries = applied.messages;
		this.lastSeq = Math.max(this.lastSeq, page.lastSeq);
		this.totalMessages = this.entries.length;
		this.visibleMessageCount += this.entries.length - previousEntryCount;
		this.#recordFeedMutation('history-later');
		return 'loaded';
	}

	invalidatePendingHistoryLoad(): void {
		this.#invalidatePageLoad();
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
		this.#recordFeedMutation('presentation-structure');
	}

	clearMessages(): void {
		this.#invalidatePageLoad();
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
		this.isLoadingMessages = false;
		this.#snapshotBuffer = null;
		this.#initialRevealPhase = 'complete';
		this.#recordFeedMutation('replacement');
	}

	compactToRecentMessages(): boolean {
		if (this.entries.length <= ACTIVE_TRANSCRIPT_RETENTION_LIMIT) return false;
		this.entries = this.entries.slice(-ACTIVE_TRANSCRIPT_RETENTION_LIMIT);
		this.oldestSeq = this.entries[0]?.seq ?? 0;
		this.totalMessages = this.entries.length;
		this.hasEarlierMessages = true;
		this.visibleMessageCount = Math.min(this.visibleMessageCount, INITIAL_VISIBLE_MESSAGES);
		this.#recordFeedMutation('presentation-structure');
		return true;
	}

	revealEarlierLoadedRows(): boolean {
		const previousCount = this.visibleMessageCount;
		this.visibleMessageCount = Math.min(this.displayMessageCount, previousCount + 100);
		const changed = this.visibleMessageCount > previousCount;
		if (changed) {
			this.pageStates.earlier = idlePageState();
			this.#recordFeedMutation('history-earlier');
		}
		return changed;
	}

	get hasInitialMessagesToReveal(): boolean {
		return this.#initialRevealPhase === 'revealing';
	}

	revealInitialMessages(): void {
		if (!this.hasInitialMessagesToReveal) return;
		const nextCount = Math.min(
			INITIAL_VISIBLE_MESSAGES,
			this.visibleMessageCount + SWITCH_REVEAL_BATCH_SIZE,
		);
		if (nextCount >= Math.min(INITIAL_VISIBLE_MESSAGES, this.displayMessageCount)) {
			this.completeInitialMessagesReveal();
			return;
		}
		this.visibleMessageCount = nextCount;
		this.#recordFeedMutation('initial');
	}

	completeInitialMessagesReveal(): void {
		const changed =
			this.visibleMessageCount < INITIAL_VISIBLE_MESSAGES ||
			this.#initialRevealPhase !== 'complete';
		this.visibleMessageCount = Math.max(this.visibleMessageCount, INITIAL_VISIBLE_MESSAGES);
		this.#initialRevealPhase = 'complete';
		if (changed) this.#recordFeedMutation('initial');
	}

	revealAllLoadedMessages(): void {
		const changed =
			this.visibleMessageCount < this.displayMessageCount ||
			this.#initialRevealPhase !== 'complete';
		this.visibleMessageCount = Math.max(this.visibleMessageCount, this.displayMessageCount);
		this.#initialRevealPhase = 'complete';
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

		try {
			const page = await getChatMessages(
				target === 'initial'
					? {
							chatId,
							limit: MESSAGES_PER_PAGE,
							beforeSeq: Math.min(latestLastSeq + 1, MESSAGES_PER_PAGE + 1),
						}
					: { chatId, limit: MESSAGES_PER_PAGE },
			);
			if (
				windowNavigationEpoch !== this.#windowNavigationEpoch ||
				loadEpoch !== this.#loadEpoch ||
				this.activeChatId !== chatId ||
				this.generationId !== generationId
			) {
				return 'invalidated';
			}
			if (page.generationId !== generationId) {
				this.transcriptCache.markStale(chatId);
				return 'invalidated';
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

			this.windowRevision += 1;
			this.entries = page.messages;
			this.oldestSeq = page.pageOldestSeq;
			this.hasEarlierMessages = false;
			this.totalMessages = page.messages.length;
			this.visibleMessageCount = page.messages.length;
			this.#initialRevealPhase = 'complete';
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

	activateChat(chatId: string | null): ChatRestoreResult | null {
		this.activeChatId = chatId;
		this.resetForNewChat();
		if (!chatId) return null;
		this.visibleMessageCount = INITIAL_SWITCH_VISIBLE_MESSAGES;
		this.#initialRevealPhase = 'pending';
		const restored = this.transcriptCache.get(chatId);
		if (!restored) return null;
		this.entries = restored.messages;
		this.generationId = restored.generationId;
		this.lastSeq = restored.lastSeq;
		this.oldestSeq = restored.oldestSeq;
		this.totalMessages = restored.messages.length;
		this.hasEarlierMessages = false;
		this.loadStatus = restored.messages.length === 0 ? 'empty' : 'loaded';
		this.#resolvePendingInitialReveal();
		return { count: restored.messages.length, stale: restored.stale };
	}

	#resolvePendingInitialReveal(): void {
		if (this.#initialRevealPhase !== 'pending') return;
		if (this.displayMessageCount > INITIAL_SWITCH_VISIBLE_MESSAGES) {
			this.#initialRevealPhase = 'revealing';
			return;
		}
		this.completeInitialMessagesReveal();
	}

	removeCachedMessages(chatId: string): void {
		this.transcriptCache.remove(chatId);
	}

	#recordFeedMutation(kind: ConversationFeedMutationKind): void {
		this.#feedMutations.record(kind);
	}
}

function sortPendingInputs(inputs: PendingUserInput[]): PendingUserInput[] {
	return inputs.slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function uniqueEntriesByClientRequestId(entries: ChatViewMessage[]): ChatViewMessage[] {
	const seenClientRequestIds = new Set<string>();
	return entries.filter((entry) => {
		const message = entry.message;
		if (!(message instanceof UserMessage) || !message.metadata?.clientRequestId) return true;
		if (seenClientRequestIds.has(message.metadata.clientRequestId)) return false;
		seenClientRequestIds.add(message.metadata.clientRequestId);
		return true;
	});
}

function applyPendingDeliveryStatuses(
	entries: ChatViewMessage[],
	pendingInputs: PendingUserInput[],
): ChatViewMessage[] {
	const unsettledStatuses = new Map(
		pendingInputs
			.filter(
				(input) => input.deliveryStatus === 'failed' || input.deliveryStatus === 'unconfirmed',
			)
			.map((input) => [input.clientRequestId, input.deliveryStatus] as const),
	);
	if (unsettledStatuses.size === 0) return entries;

	return entries.map((entry) => {
		const message = entry.message;
		if (!(message instanceof UserMessage)) return entry;
		const clientRequestId = message.metadata?.clientRequestId;
		const deliveryStatus = clientRequestId ? unsettledStatuses.get(clientRequestId) : undefined;
		if (!deliveryStatus) return entry;
		return {
			...entry,
			message: new UserMessage(message.timestamp, message.content, message.images, {
				...message.metadata,
				deliveryStatus,
			}),
		};
	});
}

function pendingInputToMessage(input: PendingUserInput): UserMessage {
	const placeholderAttachments = input.attachments?.map((attachment) => ({
		name: attachment.name,
		mimeType: 'application/octet-stream',
		data: '',
	}));
	return new UserMessage(input.createdAt, input.content, input.images ?? placeholderAttachments, {
		clientRequestId: input.clientRequestId,
		turnId: input.turnId,
		deliveryStatus: input.deliveryStatus,
	});
}

function pendingInputToRow(input: PendingUserInput): ChatTranscriptRow {
	return {
		kind: 'message',
		id: `pending:${input.clientRequestId}`,
		message: pendingInputToMessage(input),
	};
}

function mergeRowsWithPendingInputs(
	rows: ChatTranscriptRow[],
	pendingInputs: PendingUserInput[],
): ChatTranscriptRow[] {
	if (rows.length === 0) return pendingInputs.map(pendingInputToRow);

	const pendingRows = pendingInputs.map(pendingInputToRow);
	const merged: ChatTranscriptRow[] = [];
	let messageIndex = 0;
	let pendingIndex = 0;

	while (messageIndex < rows.length && pendingIndex < pendingRows.length) {
		const row = rows[messageIndex];
		const pending = pendingRows[pendingIndex];
		if (row.message.timestamp.localeCompare(pending.message.timestamp) < 0) {
			merged.push(row);
			messageIndex += 1;
		} else {
			merged.push(pending);
			pendingIndex += 1;
		}
	}

	if (messageIndex < rows.length) merged.push(...rows.slice(messageIndex));
	if (pendingIndex < pendingRows.length) merged.push(...pendingRows.slice(pendingIndex));
	return merged;
}
