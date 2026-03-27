// Debounced outbox for batching read-receipt updates. Coalesces rapid
// enqueues into periodic flushes to minimize server writes during streaming.

import { markChatsReadBatch } from '$lib/api/chats';
import type { ChatSessionsStore } from './chat-sessions.svelte';

const DEBOUNCE_MS = 2000;
const MAX_WAIT_MS = 10000;
const RETRY_DELAYS = [2000, 4000, 8000];

export class ReadReceiptOutboxStore {
	pendingByChatId: Record<string, string> = {};
	inFlight = false;
	debounceTimer: ReturnType<typeof setTimeout> | null = null;
	firstPendingAt: number | null = null;
	retryIndex = 0;

	private sessions: ChatSessionsStore;
	private flushRequested = false;
	private flushPromise: Promise<void> | null = null;

	constructor(sessions: ChatSessionsStore) {
		this.sessions = sessions;
	}

	/** Marks the given chats read immediately using their current lastActivityAt. */
	async markChatsReadNow(chatIds: string[]): Promise<void> {
		const batch = chatIds.flatMap((chatId) => {
			const chat = this.sessions.byId[chatId];
			if (!chat?.lastActivityAt || !chat.isUnread) return [];
			return [{ chatId, lastReadAt: chat.lastActivityAt }];
		});

		if (batch.length === 0) return;

		this.enqueueEntries(batch);
		for (const entry of batch) {
			this.sessions.patchLastReadAt(entry.chatId, entry.lastReadAt);
		}
		await this.flushNow();
	}

	/** Merges a read timestamp for a chat, resets debounce, checks maxWait. */
	enqueue(chatId: string, readAt: string): void {
		this.enqueueEntries([{ chatId, lastReadAt: readAt }]);
	}

	/** Cancels debounce and flushes immediately. */
	async flushNow(): Promise<void> {
		this.clearDebounce();
		await this.requestFlush();
	}

	destroy(): void {
		this.clearDebounce();
	}

	private resetDebounce(): void {
		this.clearDebounce();
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			void this.requestFlush();
		}, DEBOUNCE_MS);
	}

	private clearDebounce(): void {
		if (this.debounceTimer !== null) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}

	private enqueueEntries(entries: Array<{ chatId: string; lastReadAt: string }>): void {
		let didChange = false;
		for (const entry of entries) {
			const existing = this.pendingByChatId[entry.chatId];
			if (existing && existing >= entry.lastReadAt) continue;
			this.pendingByChatId[entry.chatId] = entry.lastReadAt;
			didChange = true;
		}

		if (!didChange) return;

		if (this.firstPendingAt === null) {
			this.firstPendingAt = Date.now();
		}

		// Force flush if maxWait exceeded.
		if (Date.now() - this.firstPendingAt >= MAX_WAIT_MS) {
			void this.flushNow();
			return;
		}

		this.resetDebounce();
	}

	private async requestFlush(): Promise<void> {
		this.flushRequested = true;
		if (this.flushPromise) {
			await this.flushPromise;
			return;
		}

		this.flushPromise = this.drainFlushRequests();
		try {
			await this.flushPromise;
		} finally {
			this.flushPromise = null;
		}
	}

	private async drainFlushRequests(): Promise<void> {
		while (this.flushRequested) {
			this.flushRequested = false;
			const waitingForRetry = await this.flush();
			if (waitingForRetry) {
				return;
			}
		}
	}

	private async flush(): Promise<boolean> {
		const entries = Object.entries(this.pendingByChatId);
		if (entries.length === 0) {
			this.firstPendingAt = null;
			return false;
		}

		this.inFlight = true;
		const batch = entries.map(([chatId, lastReadAt]) => ({ chatId, lastReadAt }));

		try {
			const response = await markChatsReadBatch(batch);
			// Clear acknowledged entries.
			for (const result of response.results) {
				const pending = this.pendingByChatId[result.chatId];
				if (pending && pending <= result.lastReadAt) {
					delete this.pendingByChatId[result.chatId];
				}
				this.sessions.patchLastReadAt(result.chatId, result.lastReadAt);
			}
			this.retryIndex = 0;
			this.firstPendingAt = Object.keys(this.pendingByChatId).length > 0
				? this.firstPendingAt
				: null;
			return false;
		} catch {
			// Retry with backoff; pending entries remain.
			const delay = RETRY_DELAYS[Math.min(this.retryIndex, RETRY_DELAYS.length - 1)];
			this.retryIndex++;
			this.debounceTimer = setTimeout(() => {
				this.debounceTimer = null;
				void this.requestFlush();
			}, delay);
			return true;
		} finally {
			this.inFlight = false;
		}
	}
}

export function createReadReceiptOutbox(sessions: ChatSessionsStore): ReadReceiptOutboxStore {
	return new ReadReceiptOutboxStore(sessions);
}
