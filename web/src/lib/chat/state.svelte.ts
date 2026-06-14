// Per-chat event-log state: event entries, cursor pagination, pending
// overlays, and resumable local snapshots.

import {
	applyChatMessageEvents,
	buildEventIndex,
	type ChatMessageEvent,
} from '$shared/chat-events';
import { AssistantMessage, ErrorMessage, UserMessage, type ChatMessage } from '$shared/chat-types';
import { normalizePendingUserInput, type PendingUserInput } from '$shared/pending-user-input';
import { LocalChatSnapshotCache } from './chat-snapshot-cache';
import { getChatMessages } from '$lib/api/chats.js';

const MESSAGES_PER_PAGE = 20;
export const INITIAL_VISIBLE_MESSAGES = 100;
type ChatPage = Awaited<ReturnType<typeof getChatMessages>>;
type PageApplyResult = 'applied' | 'generation-changed' | 'stale';

export type ChatLoadStatus = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';

export interface ChatLoadMessagesOptions {
	minimumLimit?: number;
}

export interface ChatRestoreResult {
	count: number;
	stale: boolean;
}

export interface ChatCursor {
	logId: string;
	lastAppendSeq: number;
}

export interface ChatMessageRow {
	id: string;
	message: ChatMessage;
}

function localMessageId(): string {
	return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: Math.random().toString(36).slice(2);
}

function pendingInputsFromPage(page: Pick<ChatPage, 'pendingUserInputs'>): PendingUserInput[] {
	return sortPendingInputs(
		page.pendingUserInputs
			.map(normalizePendingUserInput)
			.filter((input): input is PendingUserInput => Boolean(input)),
	);
}

export class ChatState {
	readonly snapshotCache = new LocalChatSnapshotCache();
	entries = $state<ChatMessageEvent[]>([]);
	logId = $state('');
	lastAppendSeq = $state(0);
	oldestSeq = $state(0);
	pendingUserInputs = $state<PendingUserInput[]>([]);
	localMessages = $state<Array<{ id: string; message: ChatMessage }>>([]);
	visibleMessageCount = $state(INITIAL_VISIBLE_MESSAGES);
	isLoadingMessages = $state(false);
	isLoadingMoreMessages = $state(false);
	hasMoreMessages = $state(false);
	totalMessages = $state(0);
	isUserScrolledUp = $state(false);
	loadStatus = $state<ChatLoadStatus>('idle');
	loadError = $state<string | null>(null);
	#eventIndex = new Map<string, number>();
	#snapshotBuffer: Array<{ logId: string; events: ChatMessageEvent[] }> | null = null;
	#loadEpoch = 0;
	#isLoadingMore = false;

	#echoedClientRequestIds = $derived.by(() => {
		const ids = new Set<string>();
		for (const entry of this.entries) {
			const message = entry.message;
			if (message instanceof UserMessage && message.metadata?.clientRequestId) {
				ids.add(message.metadata.clientRequestId);
			}
		}
		return ids;
	});

	#displayRows = $derived.by(() => {
		const durableRows = this.entries.map((entry) => ({
			id: entry.messageId,
			message: entry.message,
		}));
		const merged = this.visiblePendingInputs.length === 0
			? durableRows
			: mergeRowsWithPendingInputs(durableRows, this.visiblePendingInputs);
		if (this.localMessages.length === 0) return merged;
		return [...merged, ...this.localMessages];
	});

	#displayMessages = $derived.by(() => this.#displayRows.map((row) => row.message));

	#displayMessageCount = $derived.by(() => this.#displayRows.length);

	#visibleRows = $derived.by(() => {
		if (this.#displayRows.length <= this.visibleMessageCount) {
			return this.#displayRows;
		}
		return this.#displayRows.slice(-this.visibleMessageCount);
	});

	#visibleMessages = $derived.by(() => this.#visibleRows.map((row) => row.message));

	get chatMessages(): ChatMessage[] {
		return this.entries.map((entry) => entry.message);
	}

	get displayMessages(): ChatMessage[] {
		return this.#displayMessages;
	}

	get visibleRows(): ChatMessageRow[] {
		return this.#visibleRows;
	}

	get displayMessageCount(): number {
		return this.#displayMessageCount;
	}

	get visibleMessages(): ChatMessage[] {
		return this.#visibleMessages;
	}

	get visiblePendingInputs(): PendingUserInput[] {
		return this.pendingUserInputs.filter(
			(input) => !this.#echoedClientRequestIds.has(input.clientRequestId),
		);
	}

	getCursor(): ChatCursor {
		return { logId: this.logId, lastAppendSeq: this.lastAppendSeq };
	}

	applyEvents(logId: string, events: ChatMessageEvent[]): 'applied' | 'generation-changed' {
		if (this.#snapshotBuffer) {
			this.#snapshotBuffer.push({ logId, events });
			return 'applied';
		}
		if (this.logId && logId !== this.logId) {
			this.entries = [];
			this.lastAppendSeq = 0;
			this.oldestSeq = 0;
			this.#eventIndex = new Map();
			this.logId = logId;
			return 'generation-changed';
		}
		this.logId = logId;
		const result = applyChatMessageEvents(
			this.entries,
			events,
			this.lastAppendSeq,
			this.#eventIndex,
		);
		if (result.changed) this.entries = result.entries;
		this.lastAppendSeq = result.lastAppendSeq;
		this.totalMessages = this.entries.length;
		if (this.oldestSeq === 0 && this.entries.length > 0) {
			this.oldestSeq = this.entries[0].seq;
		}
		if (this.entries.length > 0 && this.loadStatus !== 'error') {
			this.loadStatus = 'loaded';
		}
		return 'applied';
	}

	beginSnapshotLoad(): number {
		const epoch = ++this.#loadEpoch;
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
		logId: string,
		events: ChatMessageEvent[],
		options: { lastAppendSeq: number; localNotice?: string },
	): void {
		this.#loadEpoch += 1;
		this.#snapshotBuffer = null;
		this.logId = logId;
		this.entries = events;
		this.lastAppendSeq = options.lastAppendSeq;
		this.oldestSeq = events.length > 0 ? events[0].seq : 0;
		this.hasMoreMessages = false;
		this.totalMessages = events.length;
		this.pendingUserInputs = [];
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.localMessages = options.localNotice
			? [{ id: `local_${localMessageId()}`, message: new ErrorMessage(new Date().toISOString(), options.localNotice) }]
			: [];
		this.#eventIndex = buildEventIndex(events);
		this.loadStatus = events.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		this.isLoadingMoreMessages = false;
		this.#isLoadingMore = false;
	}

	setFromPage(page: {
		logId: string;
		events: ChatMessageEvent[];
		lastAppendSeq: number;
		pageOldestSeq: number;
		hasMore: boolean;
	}, epoch: number): PageApplyResult {
		if (epoch !== this.#loadEpoch) return 'stale';

		const buffered = this.#snapshotBuffer ?? [];
		this.#snapshotBuffer = null;
		const hasBufferedGenerationChange = buffered.some((batch) => batch.logId !== page.logId);
		if (hasBufferedGenerationChange) {
			this.isLoadingMessages = false;
			return 'generation-changed';
		}

		this.logId = page.logId;
		this.entries = page.events;
		this.lastAppendSeq = page.lastAppendSeq;
		this.oldestSeq = page.pageOldestSeq;
		this.hasMoreMessages = page.hasMore;
		this.totalMessages = page.events.length;
		this.loadStatus = page.events.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		this.#eventIndex = buildEventIndex(page.events);
		for (const batch of buffered) {
			if (this.applyEvents(batch.logId, batch.events) === 'generation-changed') {
				return 'generation-changed';
			}
		}
		return 'applied';
	}

	async loadMessages(chatId: string, options: ChatLoadMessagesOptions = {}): Promise<ChatMessage[]> {
		if (!chatId) return [];
		const limit = Math.max(MESSAGES_PER_PAGE, Math.floor(options.minimumLimit ?? MESSAGES_PER_PAGE));
		const maxAttempts = 2;

		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const epoch = this.beginSnapshotLoad();
			try {
				const page = await getChatMessages({ chatId, limit });
				const result = this.setFromPage(page, epoch);

				if (result === 'applied') {
					this.pendingUserInputs = pendingInputsFromPage(page);
					return this.chatMessages;
				}
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

	async loadMoreMessages(chatId: string): Promise<boolean> {
		if (this.#isLoadingMore || this.isLoadingMoreMessages) return false;
		if (!this.hasMoreMessages || !chatId) return false;

		this.#isLoadingMore = true;
		this.isLoadingMoreMessages = true;
		try {
			const page = await getChatMessages({
				chatId,
				limit: MESSAGES_PER_PAGE,
				beforeSeq: this.oldestSeq,
			});
			if (page.logId !== this.logId) {
				const epoch = this.beginSnapshotLoad();
				this.setFromPage(page, epoch);
				return false;
			}
			if (page.events.length === 0) {
				this.hasMoreMessages = false;
				return false;
			}
			this.entries = [...page.events, ...this.entries];
			this.oldestSeq = page.events[0].seq;
			this.hasMoreMessages = page.hasMore;
			this.totalMessages = this.entries.length;
			this.visibleMessageCount += page.events.length;
			this.#eventIndex = buildEventIndex(this.entries);
			return true;
		} catch (error) {
			console.error('Error loading more messages:', error);
			return false;
		} finally {
			this.#isLoadingMore = false;
			this.isLoadingMoreMessages = false;
		}
	}

	appendErrorMessage(content: string): void {
		this.localMessages = [
			...this.localMessages,
			{ id: `local_${localMessageId()}`, message: new ErrorMessage(new Date().toISOString(), content) },
		];
	}

	appendLocalAssistantMessage(content: string): void {
		this.localMessages = [
			...this.localMessages,
			{ id: `local_${localMessageId()}`, message: new AssistantMessage(new Date().toISOString(), content) },
		];
	}

	setPendingUserInputs(inputs: PendingUserInput[]): void {
		this.pendingUserInputs = sortPendingInputs(inputs);
	}

	upsertPendingUserInput(input: PendingUserInput): void {
		const next = this.pendingUserInputs.slice();
		const index = next.findIndex((entry) => entry.clientRequestId === input.clientRequestId);
		if (index >= 0) next[index] = input;
		else next.push(input);
		this.pendingUserInputs = sortPendingInputs(next);
	}

	clearPendingUserInput(clientRequestId: string): void {
		this.pendingUserInputs = this.pendingUserInputs.filter(
			(input) => input.clientRequestId !== clientRequestId,
		);
	}

	updatePendingUserInputDeliveryStatus(
		clientRequestId: string,
		deliveryStatus: 'submitting' | 'accepted' | 'delivered' | 'failed',
	): void {
		this.pendingUserInputs = this.pendingUserInputs.map((input) =>
			input.clientRequestId === clientRequestId ? { ...input, deliveryStatus } : input,
		);
	}

	clearMessages(): void {
		this.entries = [];
		this.logId = '';
		this.lastAppendSeq = 0;
		this.oldestSeq = 0;
		this.pendingUserInputs = [];
		this.localMessages = [];
		this.hasMoreMessages = false;
		this.totalMessages = 0;
		this.loadStatus = 'idle';
		this.loadError = null;
		this.#snapshotBuffer = null;
		this.#eventIndex = new Map();
	}

	loadEarlierMessages(): void {
		this.visibleMessageCount += 100;
	}

	async loadAllMessages(chatId: string): Promise<void> {
		while (this.hasMoreMessages) {
			const loaded = await this.loadMoreMessages(chatId);
			if (!loaded) break;
		}
		this.visibleMessageCount = Math.max(this.visibleMessageCount, this.displayMessageCount);
	}

	resetForNewChat(): void {
		this.clearMessages();
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.isUserScrolledUp = false;
	}

	persistMessages(chatId: string): void {
		this.snapshotCache.persist(
			chatId,
			this.entries,
			{ logId: this.logId, lastAppendSeq: this.lastAppendSeq },
			{ limit: INITIAL_VISIBLE_MESSAGES },
		);
	}

	restoreMessages(chatId: string): ChatRestoreResult | null {
		const restored = this.snapshotCache.restore(chatId, { limit: INITIAL_VISIBLE_MESSAGES });
		if (!restored) return null;
		this.entries = restored.entries;
		this.logId = restored.logId;
		this.lastAppendSeq = restored.lastAppendSeq;
		this.oldestSeq = restored.entries.length > 0 ? restored.entries[0].seq : 0;
		this.totalMessages = restored.entries.length;
		this.hasMoreMessages = false;
		this.loadStatus = restored.entries.length === 0 ? 'empty' : 'loaded';
		this.#eventIndex = buildEventIndex(restored.entries);
		return { count: restored.entries.length, stale: restored.stale };
	}

	removeCachedMessages(chatId: string): void {
		this.snapshotCache.remove(chatId);
	}
}

export function createChatState(): ChatState {
	return new ChatState();
}

function sortPendingInputs(inputs: PendingUserInput[]): PendingUserInput[] {
	return inputs.slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function pendingInputToMessage(input: PendingUserInput): UserMessage {
	return new UserMessage(input.createdAt, input.content, input.images, {
		clientRequestId: input.clientRequestId,
		messageId: input.clientMessageId,
		turnId: input.turnId,
		deliveryStatus: input.deliveryStatus,
	});
}

function pendingInputToRow(input: PendingUserInput): ChatMessageRow {
	return {
		id: `pending:${input.clientRequestId}`,
		message: pendingInputToMessage(input),
	};
}

function mergeRowsWithPendingInputs(
	rows: ChatMessageRow[],
	pendingInputs: PendingUserInput[],
): ChatMessageRow[] {
	if (rows.length === 0) return pendingInputs.map(pendingInputToRow);

	const pendingRows = pendingInputs.map(pendingInputToRow);
	const merged: ChatMessageRow[] = [];
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
