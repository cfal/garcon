import {
	applyChatViewMessages,
	type ChatViewMessage,
} from '$shared/chat-view';
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
	generationId: string;
	lastSeq: number;
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
	entries = $state<ChatViewMessage[]>([]);
	generationId = $state('');
	lastSeq = $state(0);
	oldestSeq = $state(0);
	pendingUserInputs = $state<PendingUserInput[]>([]);
	localNotices = $state<Array<{ id: string; message: ChatMessage }>>([]);
	visibleMessageCount = $state(INITIAL_VISIBLE_MESSAGES);
	isLoadingMessages = $state(false);
	isLoadingMoreMessages = $state(false);
	hasMoreMessages = $state(false);
	totalMessages = $state(0);
	isUserScrolledUp = $state(false);
	loadStatus = $state<ChatLoadStatus>('idle');
	loadError = $state<string | null>(null);
	#snapshotBuffer: Array<{ generationId: string; messages: ChatViewMessage[] }> | null = null;
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
			id: `${this.generationId}:${entry.seq}`,
			message: entry.message,
		}));
		const merged = this.visiblePendingInputs.length === 0
			? durableRows
			: mergeRowsWithPendingInputs(durableRows, this.visiblePendingInputs);
		if (this.localNotices.length === 0) return merged;
		return [...merged, ...this.localNotices];
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
		return { generationId: this.generationId, lastSeq: this.lastSeq };
	}

	applyMessages(
		generationId: string,
		messages: ChatViewMessage[],
	): 'applied' | 'generation-changed' {
		if (this.#snapshotBuffer) {
			this.#snapshotBuffer.push({ generationId, messages });
			return 'applied';
		}
		if (this.generationId && generationId !== this.generationId) {
			this.entries = [];
			this.lastSeq = 0;
			this.oldestSeq = 0;
			this.generationId = generationId;
			this.localNotices = [];
			return 'generation-changed';
		}
		this.generationId = generationId;
		const result = applyChatViewMessages(this.entries, messages, this.lastSeq);
		if (result.changed) {
			this.entries = result.messages;
			this.localNotices = [];
		}
		this.lastSeq = result.lastSeq;
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
		generationId: string,
		messages: ChatViewMessage[],
		options: { lastSeq: number; pendingUserInputs?: PendingUserInput[] } = { lastSeq: 0 },
	): void {
		this.#loadEpoch += 1;
		this.#snapshotBuffer = null;
		this.generationId = generationId;
		this.entries = messages;
		this.lastSeq = options.lastSeq;
		this.oldestSeq = messages.length > 0 ? messages[0].seq : 0;
		this.hasMoreMessages = false;
		this.totalMessages = messages.length;
		this.pendingUserInputs = options.pendingUserInputs ? sortPendingInputs(options.pendingUserInputs) : [];
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.localNotices = [];
		this.loadStatus = messages.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		this.isLoadingMoreMessages = false;
		this.#isLoadingMore = false;
	}

	setFromPage(page: {
		generationId: string;
		messages: ChatViewMessage[];
		lastSeq: number;
		pageOldestSeq: number;
		hasMore: boolean;
		pendingUserInputs: PendingUserInput[];
	}, epoch: number): PageApplyResult {
		if (epoch !== this.#loadEpoch) return 'stale';

		const buffered = this.#snapshotBuffer ?? [];
		this.#snapshotBuffer = null;
		const hasBufferedGenerationChange = buffered.some((batch) => batch.generationId !== page.generationId);
		if (hasBufferedGenerationChange) {
			this.isLoadingMessages = false;
			return 'generation-changed';
		}

		this.generationId = page.generationId;
		this.entries = page.messages;
		this.lastSeq = page.lastSeq;
		this.oldestSeq = page.pageOldestSeq;
		this.hasMoreMessages = page.hasMore;
		this.totalMessages = page.messages.length;
		this.pendingUserInputs = pendingInputsFromPage(page);
		this.localNotices = [];
		this.loadStatus = page.messages.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		for (const batch of buffered) {
			if (this.applyMessages(batch.generationId, batch.messages) === 'generation-changed') {
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
			if (page.generationId !== this.generationId) {
				await this.loadMessages(chatId);
				return false;
			}
			if (page.messages.length === 0) {
				this.hasMoreMessages = false;
				return false;
			}
			this.entries = [...page.messages, ...this.entries];
			this.oldestSeq = page.messages[0].seq;
			this.lastSeq = Math.max(this.lastSeq, page.lastSeq);
			this.hasMoreMessages = page.hasMore;
			this.totalMessages = this.entries.length;
			this.visibleMessageCount += page.messages.length;
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
		this.localNotices = [
			...this.localNotices,
			{ id: `local_${localMessageId()}`, message: new ErrorMessage(new Date().toISOString(), content) },
		];
	}

	appendLocalAssistantMessage(content: string): void {
		this.localNotices = [
			...this.localNotices,
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
		deliveryStatus: 'submitting' | 'accepted' | 'failed',
	): void {
		this.pendingUserInputs = this.pendingUserInputs.map((input) =>
			input.clientRequestId === clientRequestId ? { ...input, deliveryStatus } : input,
		);
	}

	clearMessages(): void {
		this.entries = [];
		this.generationId = '';
		this.lastSeq = 0;
		this.oldestSeq = 0;
		this.pendingUserInputs = [];
		this.localNotices = [];
		this.hasMoreMessages = false;
		this.totalMessages = 0;
		this.loadStatus = 'idle';
		this.loadError = null;
		this.#snapshotBuffer = null;
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
			{ generationId: this.generationId, lastSeq: this.lastSeq },
			{ limit: INITIAL_VISIBLE_MESSAGES },
		);
	}

	restoreMessages(chatId: string): ChatRestoreResult | null {
		const restored = this.snapshotCache.restore(chatId, { limit: INITIAL_VISIBLE_MESSAGES });
		if (!restored) return null;
		this.entries = restored.entries;
		this.generationId = restored.generationId;
		this.lastSeq = restored.lastSeq;
		this.oldestSeq = restored.entries.length > 0 ? restored.entries[0].seq : 0;
		this.totalMessages = restored.entries.length;
		this.hasMoreMessages = false;
		this.loadStatus = restored.entries.length === 0 ? 'empty' : 'loaded';
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
