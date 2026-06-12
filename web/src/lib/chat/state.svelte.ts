// Per-chat message state: message arrays, pagination, scroll management,
// and message persistence via LocalChatSnapshotCache.

import { ErrorMessage, parseChatMessages, UserMessage, type ChatMessage } from '$shared/chat-types';
import { normalizePendingUserInput, type PendingUserInput } from '$shared/pending-user-input';
import { ChatMessageIdentityIndex } from '$shared/chat-message-identity';
import { LocalChatSnapshotCache } from './chat-snapshot-cache';
import { getChatMessages } from '$lib/api/chats.js';

const MESSAGES_PER_PAGE = 20;
const INITIAL_VISIBLE_MESSAGES = 100;

export type ChatLoadStatus = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';

export class ChatState {
	readonly snapshotCache = new LocalChatSnapshotCache();
	chatMessages = $state<ChatMessage[]>([]);
	pendingUserInputs = $state<PendingUserInput[]>([]);
	visibleMessageCount = $state(INITIAL_VISIBLE_MESSAGES);
	isLoadingMessages = $state(false);
	isLoadingMoreMessages = $state(false);
	totalMessages = $state(0);
	hasMoreMessages = $state(false);
	isUserScrolledUp = $state(false);
	loadStatus = $state<ChatLoadStatus>('idle');
	loadError = $state<string | null>(null);
	#messageIdentityIndex = new ChatMessageIdentityIndex();

	#displayMessages = $derived.by(() => {
		const combined = [
			...this.chatMessages.map((message) => ({ message, pending: false })),
			...this.pendingUserInputs.map((input) => ({
				message: pendingInputToMessage(input),
				pending: true,
			})),
		];
		combined.sort((left, right) => {
			const timestampOrder = left.message.timestamp.localeCompare(right.message.timestamp);
			if (timestampOrder !== 0) return timestampOrder;
			if (left.pending !== right.pending) return left.pending ? -1 : 1;
			return 0;
		});
		return combined.map((entry) => entry.message);
	});

	#displayMessageCount = $derived.by(() => this.#displayMessages.length);

	#visibleMessages = $derived.by(() => {
		if (this.#displayMessages.length <= this.visibleMessageCount) {
			return this.#displayMessages;
		}
		return this.#displayMessages.slice(-this.visibleMessageCount);
	});

	get displayMessages(): ChatMessage[] {
		return this.#displayMessages;
	}

	get displayMessageCount(): number {
		return this.#displayMessageCount;
	}

	// Visible slice of messages, capped by visibleMessageCount.
	get visibleMessages(): ChatMessage[] {
		return this.#visibleMessages;
	}

	// Tracks offset for paginated fetches from the server.
	#messagesOffset = 0;

	// Guards against concurrent loadMore calls.
	#isLoadingMore = false;

	// Generation counter to avoid stale initial-load completions clearing
	// the loading state from a newer load.
	#loadGeneration = 0;

	/** Loads messages for a chat through the REST history endpoint. */
	async loadMessages(chatId: string): Promise<ChatMessage[]> {
		if (!chatId) return [];

		const generation = ++this.#loadGeneration;
		this.isLoadingMessages = true;
		this.loadStatus = 'loading';
		this.loadError = null;
		this.#messagesOffset = 0;

		try {
			const data = await getChatMessages({ chatId, limit: MESSAGES_PER_PAGE, offset: 0 });
			const messages = parseChatMessages(data.messages);
			const pendingUserInputs = Array.isArray(data.pendingUserInputs)
				? data.pendingUserInputs
						.map(normalizePendingUserInput)
						.filter((input): input is PendingUserInput => Boolean(input))
				: [];

			if (data.hasMore !== undefined) {
				this.hasMoreMessages = Boolean(data.hasMore);
				this.totalMessages = Number(data.total || 0);
			} else {
				this.hasMoreMessages = false;
				this.totalMessages = messages.length;
			}

			this.#messagesOffset = messages.length;
			this.pendingUserInputs = sortPendingInputs(pendingUserInputs);
			this.loadStatus = messages.length === 0 ? 'empty' : 'loaded';
			return messages;
		} catch (error) {
			this.loadStatus = 'error';
			this.loadError = error instanceof Error ? error.message : 'Failed to load messages';
			throw error;
		} finally {
			if (this.#loadGeneration === generation) {
				this.isLoadingMessages = false;
			}
		}
	}

	/** Loads older messages and prepends them to the current array. */
	async loadMoreMessages(chatId: string): Promise<boolean> {
		if (this.#isLoadingMore || this.isLoadingMoreMessages) return false;
		if (!this.hasMoreMessages || !chatId) return false;

		this.#isLoadingMore = true;
		this.isLoadingMoreMessages = true;

		try {
			const data = await getChatMessages({
				chatId,
				limit: MESSAGES_PER_PAGE,
				offset: this.#messagesOffset,
			});
			const messages = parseChatMessages(data.messages);
			if (messages.length === 0) return false;

			if (data.hasMore !== undefined) {
				this.hasMoreMessages = Boolean(data.hasMore);
				this.totalMessages = Number(data.total || 0);
			} else {
				this.hasMoreMessages = false;
			}

			this.#messagesOffset += messages.length;
			this.#messageIdentityIndex.addMany(messages);
			this.chatMessages = [...messages, ...this.chatMessages];
			this.visibleMessageCount += messages.length;
			return true;
		} catch (error) {
			console.error('Error loading more messages:', error);
			return false;
		} finally {
			this.#isLoadingMore = false;
			this.isLoadingMoreMessages = false;
		}
	}

	/** Appends new messages to the end of the array. */
	appendMessages(msgs: ChatMessage[]): void {
		if (msgs.length === 0) return;
		this.#messageIdentityIndex.addMany(msgs);
		this.chatMessages = [...this.chatMessages, ...msgs];
	}

	/** Appends only messages not already represented by the identity index. */
	appendMessagesByIdentity(msgs: ChatMessage[]): void {
		if (msgs.length === 0) return;
		const nextMessages = this.#messageIdentityIndex.takeNew(msgs);
		if (nextMessages.length === 0) return;
		this.chatMessages = [...this.chatMessages, ...nextMessages];
	}

	/** Appends a local error row to the durable message list. */
	appendErrorMessage(content: string): void {
		this.appendMessages([new ErrorMessage(new Date().toISOString(), content)]);
	}

	/** Replaces the entire durable message array. */
	setMessages(msgs: ChatMessage[]): void {
		this.#messageIdentityIndex.reset(msgs);
		this.chatMessages = msgs;
	}

	setPendingUserInputs(inputs: PendingUserInput[]): void {
		this.pendingUserInputs = sortPendingInputs(inputs);
	}

	upsertPendingUserInput(input: PendingUserInput): void {
		const next = this.pendingUserInputs.slice();
		const index = next.findIndex((entry) => entry.clientRequestId === input.clientRequestId);
		if (index >= 0) {
			next[index] = input;
		} else {
			next.push(input);
		}
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

	/** Clears all messages and resets pagination state. */
	clearMessages(): void {
		this.#messageIdentityIndex.reset();
		this.chatMessages = [];
		this.pendingUserInputs = [];
		this.#messagesOffset = 0;
		this.hasMoreMessages = false;
		this.totalMessages = 0;
		this.loadStatus = 'idle';
		this.loadError = null;
	}

	/** Increases the visible message window by 100. */
	loadEarlierMessages(): void {
		this.visibleMessageCount += 100;
	}

	/** Loads all remaining paginated messages so the full history is available. */
	async loadAllMessages(chatId: string): Promise<void> {
		while (this.hasMoreMessages) {
			const loaded = await this.loadMoreMessages(chatId);
			if (!loaded) break;
		}
		this.visibleMessageCount = Math.max(this.visibleMessageCount, this.chatMessages.length);
	}

	/** Resets scroll and pagination state for a new chat selection. */
	resetForNewChat(): void {
		this.#messageIdentityIndex.reset();
		this.chatMessages = [];
		this.pendingUserInputs = [];
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.isUserScrolledUp = false;
		this.#messagesOffset = 0;
		this.hasMoreMessages = false;
		this.totalMessages = 0;
		this.loadStatus = 'idle';
		this.loadError = null;
	}

	/** Persists current durable messages via the snapshot cache. */
	persistMessages(chatId: string): void {
		this.snapshotCache.persist(chatId, this.chatMessages);
	}

	/** Restores durable messages from the snapshot cache. */
	restoreMessages(chatId: string): boolean {
		const restored = this.snapshotCache.restore(chatId);
		if (!restored) return false;
		this.setMessages(restored.messages);
		return true;
	}

	/** Removes cached messages for the given chat ID. */
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
