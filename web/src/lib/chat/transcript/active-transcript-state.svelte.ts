import { applyChatViewMessages, type ChatViewMessage, type ChatViewPage } from '$shared/chat-view';
import {
	UserMessage,
	type ChatMessage,
	type UserMessageDeliveryStatus,
} from '$shared/chat-types';
import { normalizePendingUserInput, type PendingUserInput } from '$shared/pending-user-input';
import { ChatTranscriptCache } from './chat-transcript-cache.svelte';
import { getChatMessages } from '$lib/api/chats.js';
import type { LocalNoticeRow, LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import { createRandomId } from '$lib/utils/random-id';

const MESSAGES_PER_PAGE = 50;
export const INITIAL_VISIBLE_MESSAGES = 100;
export const INITIAL_SWITCH_VISIBLE_MESSAGES = 20;
export const ACTIVE_TRANSCRIPT_RETENTION_LIMIT = 200;
const SWITCH_REVEAL_BATCH_SIZE = 20;
type ChatPage = Awaited<ReturnType<typeof getChatMessages>>;
export type MessageApplyResult = 'applied' | 'generation-changed' | 'gap-detected';
type PageApplyResult = MessageApplyResult | 'stale';
type InitialRevealPhase = 'pending' | 'revealing' | 'complete';

export type ChatLoadStatus = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';
export type TranscriptPageLoadResult = 'loaded' | 'exhausted' | 'invalidated' | 'failed';
export type TranscriptWindowLoadResult = 'loaded' | 'invalidated' | 'failed';
export type TranscriptWindowTarget = 'initial' | 'latest';

export interface ChatLoadMessagesOptions {
	minimumLimit?: number;
}

export interface ChatRestoreResult {
	count: number;
	stale: boolean;
}

export interface ChatCursor {
	generationId: string;
	lastSeq: number;
}

export interface ChatTranscriptRow {
	kind: 'message';
	id: string;
	message: ChatMessage;
	seq?: number;
}

export type ChatDisplayRow = ChatTranscriptRow | LocalNoticeRow;

function localMessageId(): string {
	return createRandomId();
}

function pendingInputsFromPage(page: Pick<ChatPage, 'pendingUserInputs'>): PendingUserInput[] {
	return sortPendingInputs(
		page.pendingUserInputs
			.map(normalizePendingUserInput)
			.filter((input): input is PendingUserInput => Boolean(input)),
	);
}

export interface ActiveTranscriptPort {
	readonly transcriptCache: ChatTranscriptCache;
	activeChatId: string | null;
	readonly entries: readonly ChatViewMessage[];
	readonly chatMessages: ChatMessage[];
	isUserScrolledUp: boolean;
	getCursor(): ChatCursor;
	applyMessages(
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
	): MessageApplyResult;
	loadMessages(chatId: string, options?: ChatLoadMessagesOptions): Promise<ChatMessage[]>;
	appendLocalNotice(noticeType: LocalNoticeType, content: string): void;
	clearLocalNotices(): void;
	setPendingUserInputs(inputs: PendingUserInput[]): void;
	upsertPendingUserInput(input: PendingUserInput): void;
	clearPendingUserInput(clientRequestId: string): void;
	updatePendingUserInputDeliveryStatus(
		clientRequestId: string,
		deliveryStatus: UserMessageDeliveryStatus,
	): void;
	activateChat(chatId: string | null): ChatRestoreResult | null;
}

export class ActiveTranscriptState implements ActiveTranscriptPort {
	readonly transcriptCache: ChatTranscriptCache;
	activeChatId = $state<string | null>(null);
	entries = $state<ChatViewMessage[]>([]);
	generationId = $state('');
	lastSeq = $state(0);
	oldestSeq = $state(0);
	pendingUserInputs = $state<PendingUserInput[]>([]);
	localNotices = $state<LocalNoticeRow[]>([]);
	visibleMessageCount = $state(INITIAL_VISIBLE_MESSAGES);
	isLoadingMessages = $state(false);
	isLoadingMoreMessages = $state(false);
	hasMoreMessages = $state(false);
	totalMessages = $state(0);
	isUserScrolledUp = $state(false);
	loadStatus = $state<ChatLoadStatus>('idle');
	loadError = $state<string | null>(null);
	isViewingInitialMessages = $state(false);
	#snapshotBuffer: Array<{ generationId: string; messages: ChatViewMessage[] }> | null = null;
	#loadEpoch = 0;
	#pendingUserInputsRevision = 0;
	#pendingUserInputsRevisionAtLoadStart = 0;
	#loadMorePromise: Promise<TranscriptPageLoadResult> | null = null;
	#loadingMoreChatId: string | null = null;
	#loadLaterPromise: Promise<TranscriptPageLoadResult> | null = null;
	#loadingLaterChatId: string | null = null;
	#loadMoreOperationEpoch = 0;
	#windowNavigationEpoch = 0;
	#detachedWindowLastSeq = 0;
	#initialRevealPhase = $state<InitialRevealPhase>('complete');

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
		this.isViewingInitialMessages ? ([] as LocalNoticeRow[]) : this.localNotices,
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

	get visiblePendingInputs(): PendingUserInput[] {
		if (this.isViewingInitialMessages) return [];
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
	): MessageApplyResult {
		if (this.#snapshotBuffer) {
			this.transcriptCache.applyMessages(chatId, generationId, messages);
			this.#snapshotBuffer.push({ generationId, messages });
			return 'applied';
		}
		if (this.generationId && generationId !== this.generationId) {
			this.#invalidateLoadMoreOperation();
			this.transcriptCache.markStale(chatId);
			return 'generation-changed';
		}
		const result = this.transcriptCache.applyMessages(chatId, generationId, messages);
		if (result.status === 'generation-changed') {
			this.#invalidateLoadMoreOperation();
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
		if (this.isViewingInitialMessages) {
			this.generationId = generationId;
			this.lastSeq = result.lastSeq;
			this.#detachedWindowLastSeq = Math.max(this.#detachedWindowLastSeq, result.lastSeq);
			if (result.changed) {
				this.localNotices = [];
			}
			if (this.entries.length > 0 && this.loadStatus !== 'error') {
				this.loadStatus = 'loaded';
			}
			return 'applied';
		}
		const applied = applyChatViewMessages(this.entries, messages, this.lastSeq);
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
				this.hasMoreMessages = true;
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
		if (result.changed) {
			this.localNotices = [];
		}
		this.totalMessages = this.entries.length;
		if (this.entries.length > 0 && this.loadStatus !== 'error') {
			this.loadStatus = 'loaded';
		}
		return 'applied';
	}

	beginSnapshotLoad(): number {
		const epoch = this.#beginLoadEpoch();
		this.#snapshotBuffer = [];
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

	replaceGeneration(
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
		options: Pick<ChatViewPage, 'lastSeq' | 'pageOldestSeq' | 'hasMore'> & {
			pendingUserInputs?: PendingUserInput[];
		},
	): void {
		this.#invalidateLoadMoreOperation();
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
		this.generationId = generationId;
		this.entries = messages;
		this.lastSeq = options.lastSeq;
		this.oldestSeq = options.pageOldestSeq;
		this.hasMoreMessages = options.hasMore;
		this.totalMessages = messages.length;
		this.#replacePendingUserInputs(options.pendingUserInputs ?? []);
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.#initialRevealPhase = 'complete';
		this.isViewingInitialMessages = false;
		this.#detachedWindowLastSeq = 0;
		this.localNotices = [];
		this.loadStatus = messages.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		this.isLoadingMoreMessages = false;
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
			this.#invalidateLoadMoreOperation();
			this.isLoadingMessages = false;
			return 'generation-changed';
		}

		this.#invalidateLoadMoreOperation();
		this.transcriptCache.replaceFromPage(chatId, page);
		this.generationId = page.generationId;
		this.entries = page.messages;
		this.lastSeq = page.lastSeq;
		this.oldestSeq = page.pageOldestSeq;
		this.hasMoreMessages = page.hasMore;
		this.totalMessages = page.messages.length;
		if (this.#pendingUserInputsRevision === this.#pendingUserInputsRevisionAtLoadStart) {
			this.#replacePendingUserInputs(pendingInputsFromPage(page));
		}
		this.localNotices = [];
		this.loadStatus = page.messages.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		this.isViewingInitialMessages = false;
		this.#detachedWindowLastSeq = 0;
		for (const batch of buffered) {
			const result = this.applyMessages(chatId, batch.generationId, batch.messages);
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
				this.abortSnapshotLoad(epoch);
				this.loadStatus = 'error';
				this.loadError = error instanceof Error ? error.message : 'Failed to load messages';
				throw error;
			}
		}

		this.loadStatus = 'error';
		this.loadError = 'Chat generation changed while loading messages';
		throw new Error(this.loadError);
	}

	async loadMoreMessages(chatId: string): Promise<TranscriptPageLoadResult> {
		if (this.#loadMorePromise) {
			return this.#loadingMoreChatId === chatId ? this.#loadMorePromise : 'invalidated';
		}
		if (!this.hasMoreMessages || !chatId) return 'exhausted';

		const generationId = this.generationId;
		const operationEpoch = this.#loadMoreOperationEpoch;
		this.isLoadingMoreMessages = true;
		const loadPromise = this.#performLoadMoreMessages(chatId, generationId, operationEpoch);
		this.#loadMorePromise = loadPromise;
		this.#loadingMoreChatId = chatId;
		try {
			return await loadPromise;
		} finally {
			if (this.#loadMorePromise === loadPromise) {
				this.#loadMorePromise = null;
				this.#loadingMoreChatId = null;
				this.isLoadingMoreMessages = false;
			}
		}
	}

	async #performLoadMoreMessages(
		chatId: string,
		generationId: string,
		operationEpoch: number,
	): Promise<TranscriptPageLoadResult> {
		try {
			const page = await getChatMessages({
				chatId,
				limit: MESSAGES_PER_PAGE,
				beforeSeq: this.oldestSeq,
			});
			if (!this.#isCurrentLoadMoreOperation(chatId, generationId, operationEpoch)) {
				return 'invalidated';
			}
			if (page.generationId !== generationId) {
				await this.loadMessages(chatId);
				return 'invalidated';
			}
			if (page.messages.length === 0) {
				this.hasMoreMessages = false;
				return 'exhausted';
			}
			this.entries = [...page.messages, ...this.entries];
			this.oldestSeq = page.messages[0].seq;
			this.lastSeq = Math.max(this.lastSeq, page.lastSeq);
			this.hasMoreMessages = page.hasMore;
			this.totalMessages = this.entries.length;
			this.visibleMessageCount += page.messages.length;
			return 'loaded';
		} catch (error) {
			console.error('Error loading more messages:', error);
			return 'failed';
		}
	}

	async loadLaterMessages(chatId: string): Promise<TranscriptPageLoadResult> {
		if (this.#loadLaterPromise) {
			return this.#loadingLaterChatId === chatId ? this.#loadLaterPromise : 'invalidated';
		}
		if (!this.isViewingInitialMessages || !chatId) return 'exhausted';

		const generationId = this.generationId;
		const operationEpoch = this.#loadMoreOperationEpoch;
		const newestSeq = this.entries.at(-1)?.seq ?? 0;
		if (newestSeq >= this.#detachedWindowLastSeq) {
			this.isViewingInitialMessages = false;
			this.#detachedWindowLastSeq = 0;
			return 'exhausted';
		}

		const loadPromise = this.#performLoadLaterMessages(
			chatId,
			generationId,
			operationEpoch,
			newestSeq,
		);
		this.#loadLaterPromise = loadPromise;
		this.#loadingLaterChatId = chatId;
		try {
			return await loadPromise;
		} finally {
			if (this.#loadLaterPromise === loadPromise) {
				this.#loadLaterPromise = null;
				this.#loadingLaterChatId = null;
			}
		}
	}

	async #performLoadLaterMessages(
		chatId: string,
		generationId: string,
		operationEpoch: number,
		newestSeq: number,
	): Promise<TranscriptPageLoadResult> {
		try {
			const page = await getChatMessages({
				chatId,
				limit: MESSAGES_PER_PAGE,
				beforeSeq: Math.min(newestSeq + MESSAGES_PER_PAGE + 1, this.#detachedWindowLastSeq + 1),
			});
			if (!this.#isCurrentLoadMoreOperation(chatId, generationId, operationEpoch)) {
				return 'invalidated';
			}
			if (page.generationId !== generationId) {
				await this.loadMessages(chatId);
				return 'invalidated';
			}

			const previousEntryCount = this.entries.length;
			const applied = applyChatViewMessages(this.entries, page.messages, newestSeq);
			if (applied.status !== 'applied' || !applied.changed) return 'failed';

			this.entries = applied.messages;
			this.totalMessages = this.entries.length;
			this.visibleMessageCount += this.entries.length - previousEntryCount;
			this.#detachedWindowLastSeq = Math.max(
				this.#detachedWindowLastSeq,
				this.lastSeq,
				page.lastSeq,
			);

			if ((this.entries.at(-1)?.seq ?? 0) >= this.#detachedWindowLastSeq) {
				this.transcriptCache.replaceFromPage(chatId, page);
				this.lastSeq = Math.max(this.lastSeq, page.lastSeq);
				this.isViewingInitialMessages = false;
				this.#detachedWindowLastSeq = 0;
			}
			return 'loaded';
		} catch (error) {
			console.error('Error loading later messages:', error);
			return 'failed';
		}
	}

	invalidatePendingHistoryLoad(): void {
		this.#invalidateLoadMoreOperation();
	}

	#isCurrentLoadMoreOperation(
		chatId: string,
		generationId: string,
		operationEpoch: number,
	): boolean {
		return (
			this.#loadMoreOperationEpoch === operationEpoch &&
			this.activeChatId === chatId &&
			this.generationId === generationId
		);
	}

	#invalidateLoadMoreOperation(): void {
		this.#loadMoreOperationEpoch += 1;
		this.#loadMorePromise = null;
		this.#loadingMoreChatId = null;
		this.#loadLaterPromise = null;
		this.#loadingLaterChatId = null;
		this.isLoadingMoreMessages = false;
	}

	appendLocalNotice(noticeType: LocalNoticeType, content: string): void {
		this.localNotices = [
			...this.localNotices,
			{
				kind: 'local-notice',
				id: `local_${localMessageId()}`,
				noticeType,
				content,
				timestamp: new Date().toISOString(),
			},
		];
	}

	clearLocalNotices(): void {
		this.localNotices = [];
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
	}

	clearMessages(): void {
		this.#invalidateLoadMoreOperation();
		this.#loadEpoch += 1;
		this.entries = [];
		this.generationId = '';
		this.lastSeq = 0;
		this.oldestSeq = 0;
		this.#replacePendingUserInputs([]);
		this.localNotices = [];
		this.hasMoreMessages = false;
		this.totalMessages = 0;
		this.loadStatus = 'idle';
		this.loadError = null;
		this.#snapshotBuffer = null;
		this.#initialRevealPhase = 'complete';
		this.isViewingInitialMessages = false;
		this.#detachedWindowLastSeq = 0;
	}

	compactToRecentMessages(): boolean {
		if (this.entries.length <= ACTIVE_TRANSCRIPT_RETENTION_LIMIT) return false;
		this.entries = this.entries.slice(-ACTIVE_TRANSCRIPT_RETENTION_LIMIT);
		this.oldestSeq = this.entries[0]?.seq ?? 0;
		this.totalMessages = this.entries.length;
		this.hasMoreMessages = true;
		this.visibleMessageCount = Math.min(this.visibleMessageCount, INITIAL_VISIBLE_MESSAGES);
		return true;
	}

	loadEarlierMessages(): void {
		this.visibleMessageCount += 100;
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
	}

	completeInitialMessagesReveal(): void {
		this.visibleMessageCount = Math.max(this.visibleMessageCount, INITIAL_VISIBLE_MESSAGES);
		this.#initialRevealPhase = 'complete';
	}

	revealAllLoadedMessages(): void {
		this.visibleMessageCount = Math.max(this.visibleMessageCount, this.displayMessageCount);
		this.#initialRevealPhase = 'complete';
	}

	async navigateToWindow(
		chatId: string,
		target: TranscriptWindowTarget,
	): Promise<TranscriptWindowLoadResult> {
		if (!chatId || this.activeChatId !== chatId) return 'invalidated';
		if (this.#snapshotBuffer) return 'invalidated';
		const alreadyAtTarget =
			target === 'latest'
				? !this.isViewingInitialMessages
				: this.isViewingInitialMessages ||
					(this.oldestSeq === 1 &&
						this.entries.length <= MESSAGES_PER_PAGE &&
						this.entries.at(-1)?.seq === this.lastSeq);

		const windowNavigationEpoch = ++this.#windowNavigationEpoch;
		const loadEpoch = this.#beginLoadEpoch();
		this.#invalidateLoadMoreOperation();
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

			this.entries = page.messages;
			this.oldestSeq = page.pageOldestSeq;
			this.hasMoreMessages = false;
			this.totalMessages = page.messages.length;
			this.visibleMessageCount = page.messages.length;
			this.#initialRevealPhase = 'complete';
			const initialWindowServerLastSeq = Math.max(this.lastSeq, page.lastSeq);
			this.isViewingInitialMessages = (page.messages.at(-1)?.seq ?? 0) < initialWindowServerLastSeq;
			if (this.isViewingInitialMessages) {
				this.#detachedWindowLastSeq = initialWindowServerLastSeq;
				this.isUserScrolledUp = true;
			} else {
				this.#detachedWindowLastSeq = 0;
			}
			this.loadStatus = page.messages.length === 0 ? 'empty' : 'loaded';
			this.loadError = null;
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
		this.hasMoreMessages = false;
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
