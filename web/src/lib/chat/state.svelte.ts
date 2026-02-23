// Per-chat message state: message arrays, pagination, scroll management,
// and message persistence to localStorage.

import { parseChatMessages, type ChatMessage } from '$shared/chat-types';
import { ChatLogQueryRequest } from '$shared/ws-requests';
import type { WsConnection } from '$lib/ws/connection.svelte';

const MESSAGES_PER_PAGE = 20;
const INITIAL_VISIBLE_MESSAGES = 100;
const CHAT_LOG_TIMEOUT_MS = 45_000;

export type ChatLoadStatus = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';

export class ChatState {
	chatMessages = $state<ChatMessage[]>([]);
	visibleMessageCount = $state(INITIAL_VISIBLE_MESSAGES);
	isLoadingMessages = $state(false);
	isLoadingMoreMessages = $state(false);
	totalMessages = $state(0);
	hasMoreMessages = $state(false);
	isUserScrolledUp = $state(false);
	loadStatus = $state<ChatLoadStatus>('idle');
	loadError = $state<string | null>(null);

	// Visible slice of messages, capped by visibleMessageCount.
	get visibleMessages(): ChatMessage[] {
		if (this.chatMessages.length <= this.visibleMessageCount) {
			return this.chatMessages;
		}
		return this.chatMessages.slice(-this.visibleMessageCount);
	}

	// Tracks offset for paginated fetches from the server.
	#messagesOffset = 0;

	// Guards against concurrent loadMore calls.
	#isLoadingMore = false;

	// Generation counter to avoid stale initial-load completions clearing
	// the loading state from a newer load.
	#loadGeneration = 0;

	/** Loads messages for a chat from the server via WebSocket.
	 *  Throws on transport failure so callers can distinguish
	 *  "no connection" from "empty chat". */
	async loadMessages(chatId: string, ws: WsConnection): Promise<ChatMessage[]> {
		if (!chatId) return [];

		const generation = ++this.#loadGeneration;
		this.isLoadingMessages = true;
		this.loadStatus = 'loading';
		this.loadError = null;
		this.#messagesOffset = 0;

		try {
			const data = await ws.sendRequest<{
				messages?: ChatMessage[];
				hasMore?: boolean;
				total?: number;
			}>(new ChatLogQueryRequest(null, chatId, MESSAGES_PER_PAGE, 0), CHAT_LOG_TIMEOUT_MS);

			const messages = parseChatMessages(data.messages);

			if (data.hasMore !== undefined) {
				this.hasMoreMessages = Boolean(data.hasMore);
				this.totalMessages = Number(data.total || 0);
			} else {
				this.hasMoreMessages = false;
				this.totalMessages = messages.length;
			}

			this.#messagesOffset = messages.length;
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
	async loadMoreMessages(chatId: string, ws: WsConnection): Promise<boolean> {
		if (this.#isLoadingMore || this.isLoadingMoreMessages) return false;
		if (!this.hasMoreMessages || !chatId) return false;

		this.#isLoadingMore = true;
		this.isLoadingMoreMessages = true;

		try {
			const data = await ws.sendRequest<{
				messages?: ChatMessage[];
				hasMore?: boolean;
				total?: number;
			}>(new ChatLogQueryRequest(null, chatId, MESSAGES_PER_PAGE, this.#messagesOffset));

			const messages = parseChatMessages(data.messages);
			if (messages.length === 0) return false;

			if (data.hasMore !== undefined) {
				this.hasMoreMessages = Boolean(data.hasMore);
				this.totalMessages = Number(data.total || 0);
			} else {
				this.hasMoreMessages = false;
			}

			this.#messagesOffset += messages.length;
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
		this.chatMessages = [...this.chatMessages, ...msgs];
	}

	/** Replaces the entire message array. */
	setMessages(msgs: ChatMessage[]): void {
		this.chatMessages = msgs;
	}

	/** Clears all messages and resets pagination state. */
	clearMessages(): void {
		this.chatMessages = [];
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

	/** Resets scroll and pagination state for a new chat selection. */
	resetForNewChat(): void {
		this.chatMessages = [];
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.isUserScrolledUp = false;
		this.#messagesOffset = 0;
		this.hasMoreMessages = false;
		this.totalMessages = 0;
		this.loadStatus = 'idle';
		this.loadError = null;
	}

	/** Persists current messages to localStorage for the given chat ID. */
	persistMessages(chatId: string): void {
		if (!chatId) return;
		const key = `chat_messages_${chatId}`;
		try {
			if (this.chatMessages.length > 0) {
				localStorage.setItem(key, JSON.stringify(this.chatMessages));
			} else {
				localStorage.removeItem(key);
			}
		} catch {
			// Storage full or unavailable
		}
	}

	/** Restores messages from localStorage for the given chat ID. */
	restoreMessages(chatId: string): boolean {
		if (!chatId) return false;
		const key = `chat_messages_${chatId}`;
		try {
			const saved = localStorage.getItem(key);
			if (saved) {
				this.chatMessages = parseChatMessages(JSON.parse(saved));
				return true;
			}
		} catch {
			localStorage.removeItem(key);
		}
		return false;
	}
}

export function createChatState(): ChatState {
	return new ChatState();
}
